#!/usr/bin/env node
/** Restore the normal preview launcher after a disposable synthetic drill. */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REGION = 'us-east-1';
const ACCOUNT = '205064803661';
const LAUNCHER = 'openapply-staging-fargate-launcher';
const PREVIEW = 'openapply-staging-browser-preview';
const SYNTHETIC = 'openapply-staging-synthetic-queue';
const CLUSTER = 'openapply-staging-browser';
const LEDGER = 'openapply-staging-run-ledger';

function aws(args) {
  return execFileSync('aws', [...args, '--region', REGION, '--output', 'json'],
    { encoding: 'utf8', timeout: 40_000 });
}
function json(args) { return JSON.parse(aws(args)); }
function stack(name) { return json(['cloudformation', 'describe-stacks', '--stack-name', name]).Stacks?.[0]; }
function output(value, name) { return value?.Outputs?.find(item => item.OutputKey === name)?.OutputValue; }

export function updateParameters(current, replacements) {
  const names = new Set(current.map(item => item.ParameterKey));
  for (const name of Object.keys(replacements)) {
    if (!names.has(name)) throw new Error(`Launcher parameter ${name} is unavailable`);
  }
  return current.map(item => Object.hasOwn(replacements, item.ParameterKey)
    ? { ParameterKey: item.ParameterKey, ParameterValue: replacements[item.ParameterKey] }
    : { ParameterKey: item.ParameterKey, UsePreviousValue: true });
}

function updateLauncher(replacements) {
  const current = stack(LAUNCHER);
  if (!current || !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(current.StackStatus)) {
    throw new Error('Launcher stack is not updateable');
  }
  const parameters = updateParameters(current.Parameters ?? [], replacements);
  try {
    aws(['cloudformation', 'update-stack', '--stack-name', LAUNCHER,
      '--use-previous-template', '--capabilities', 'CAPABILITY_IAM',
      '--parameters', JSON.stringify(parameters)]);
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    if (!stderr.includes('No updates are to be performed')) throw error;
    return;
  }
  execFileSync('aws', ['cloudformation', 'wait', 'stack-update-complete',
    '--stack-name', LAUNCHER, '--region', REGION], { stdio: 'inherit', timeout: 900_000 });
}

function taskArns() {
  // ECS can still be starting a task when rollback begins. Stop both states;
  // otherwise a PENDING task could become RUNNING after the final slot check.
  return [...new Set(['PENDING', 'RUNNING'].flatMap(status =>
    json(['ecs', 'list-tasks', '--cluster', CLUSTER, '--desired-status', status]).taskArns ?? []))];
}

function stopSyntheticTasks(syntheticArn) {
  const arns = taskArns();
  if (!arns.length) return;
  const tasks = json(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', ...arns]).tasks ?? [];
  if (tasks.length !== arns.length || tasks.some(task => task.taskDefinitionArn !== syntheticArn)) {
    throw new Error('Non-synthetic browser task is pending or running; do not stop it automatically');
  }
  for (const task of tasks) {
    aws(['ecs', 'stop-task', '--cluster', CLUSTER, '--task', task.taskArn,
      '--reason', 'OpenApply bounded synthetic drill rollback']);
  }
  execFileSync('aws', ['ecs', 'wait', 'tasks-stopped', '--cluster', CLUSTER,
    '--tasks', ...arns, '--region', REGION], { stdio: 'inherit', timeout: 900_000 });
}

async function waitForClearSlots() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const occupied = [0, 1].some(slot => {
      const value = json(['dynamodb', 'get-item', '--table-name', LEDGER,
        '--key', JSON.stringify({ pk: { S: 'LAUNCHER#staging' }, sk: { S: `SLOT#${slot}` } }),
        '--consistent-read']);
      return Boolean(value.Item);
    });
    if (!occupied) return;
    await new Promise(resolve => setTimeout(resolve, 30_000));
  }
  throw new Error('Launcher slots did not clear after stopped-task reconciliation');
}

async function restore() {
  const caller = json(['sts', 'get-caller-identity']);
  if (caller.Account !== ACCOUNT) throw new Error('AWS account mismatch');
  const preview = stack(PREVIEW);
  const synthetic = stack(SYNTHETIC);
  const previewArn = output(preview, 'TaskDefinitionArn');
  const syntheticArn = output(synthetic, 'TaskDefinitionArn');
  const previewRole = output(preview, 'TaskRoleArn');
  const previewExecutionRole = output(preview, 'ExecutionRoleArn');
  if (!previewArn || !syntheticArn || !previewArn.includes(':task-definition/openapply-staging-browser-preview:')
    || !syntheticArn.includes(':task-definition/openapply-staging-synthetic-queue:')
    || !previewRole || !previewExecutionRole) {
    throw new Error('Reviewed preview/synthetic task stacks are unavailable');
  }
  // Stop new reservations first. A currently running synthetic task may still
  // finish; the following step waits for ECS STOPPED and slot reconciliation.
  updateLauncher({ MaxConcurrentBrowserTasks: '1' });
  stopSyntheticTasks(syntheticArn);
  await waitForClearSlots();
  updateLauncher({ EcsTaskDefinitionArn: previewArn,
    EcsTaskRoleArn: previewRole,
    EcsExecutionRoleArn: previewExecutionRole,
    MaxConcurrentBrowserTasks: '1' });
  execFileSync('node', ['scripts/aws-preview-launcher-preflight.mjs',
    '--account-id', ACCOUNT], { stdio: 'inherit', timeout: 40_000 });
  process.stdout.write('Preview launcher restored at capacity one. Synthetic stack can be deleted after fixture cleanup.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== '--account-id' || process.argv[3] !== ACCOUNT) {
    process.stderr.write(`Usage: node scripts/aws-synthetic-drill-rollback.mjs --account-id ${ACCOUNT}\n`);
    process.exitCode = 2;
  } else restore().catch(error => {
    process.stderr.write(`Synthetic rollback incomplete: ${error.message}\n`);
    process.exitCode = 1;
  });
}
