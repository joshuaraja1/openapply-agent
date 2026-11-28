#!/usr/bin/env node
/** Read-only inventory gate for the deployed pre-submit Fargate launcher. */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const stackNames = {
  control: 'openapply-staging-control-plane',
  billing: 'openapply-billing-staging',
  browser: 'openapply-staging-browser-smoke',
  cognito: 'openapply-staging-cognito',
  onboarding: 'openapply-staging-onboarding',
  broker: 'openapply-staging-artifact-broker',
  preview: 'openapply-staging-browser-preview',
  launcher: 'openapply-staging-fargate-launcher',
  egress: 'openapply-staging-browser-egress',
};

const output = (stack, name) => stack?.Outputs?.find(item => item.OutputKey === name)?.OutputValue;
const parameter = (stack, name) => stack?.Parameters?.find(item => item.ParameterKey === name)?.ParameterValue;

export function assessPreviewLauncher(accountId, expectedAccountId, stacks, taskDefinition,
  runLedgerTable) {
  const checks = [];
  const add = (gate, ok, detail) => checks.push({ gate, ok: Boolean(ok), detail });
  add('account', accountId === expectedAccountId,
    accountId === expectedAccountId ? 'expected account' : 'AWS account mismatch');
  for (const [key, stack] of Object.entries(stacks)) {
    add(key, stack?.StackStatus === 'CREATE_COMPLETE' || stack?.StackStatus === 'UPDATE_COMPLETE',
      stack ? `stack ${stack.StackStatus}` : 'stack missing');
  }
  const { control, billing, browser, cognito, onboarding, broker, preview, launcher, egress } = stacks;
  const links = [
    ['preview.ArtifactBucketName', parameter(preview, 'ArtifactBucketName'), output(control, 'PrivateArtifactsBucket')],
    ['preview.ArtifactKmsKeyArn', parameter(preview, 'ArtifactKmsKeyArn'), output(onboarding, 'CandidateDataKeyArn')],
    ['preview.ArtifactBrokerArn', parameter(preview, 'ArtifactBrokerArn'), output(broker, 'BrokerFunctionArn')],
    ['launcher.EcsClusterArn', parameter(launcher, 'EcsClusterArn'), output(browser, 'ClusterArn')],
    ['launcher.EcsTaskDefinitionArn', parameter(launcher, 'EcsTaskDefinitionArn'), output(preview, 'TaskDefinitionArn')],
    ['launcher.EcsTaskRoleArn', parameter(launcher, 'EcsTaskRoleArn'), output(preview, 'TaskRoleArn')],
    ['launcher.EcsExecutionRoleArn', parameter(launcher, 'EcsExecutionRoleArn'), output(preview, 'ExecutionRoleArn')],
    ['launcher.EcsSecurityGroupId', parameter(launcher, 'EcsSecurityGroupId'), output(browser, 'EgressOnlySecurityGroupId')],
    ['launcher.PrivateSubnetIds', parameter(launcher, 'PrivateSubnetIds'), output(egress, 'PrivateSubnetId')],
    ['launcher.RunLedgerTableName', parameter(launcher, 'RunLedgerTableName'), output(control, 'RunLedgerName')],
    ['launcher.EntitlementTableName', parameter(launcher, 'EntitlementTableName'), output(billing, 'EntitlementTableName')],
  ];
  const mismatched = links.filter(([, actual, expected]) => !expected || actual !== expected)
    .map(([name]) => name);
  add('resource-links', mismatched.length === 0,
    mismatched.length ? `mismatched ${mismatched.join(', ')}` : 'exact stack links');
  add('launcher-enabled', parameter(launcher, 'EnableFargateLauncher') === 'true'
    && parameter(launcher, 'DeletionStopGateReady') === 'true',
  'launcher and deletion stop gate enabled');
  const capacity = Number(parameter(launcher, 'MaxConcurrentBrowserTasks'));
  add('bounded-capacity', Number.isInteger(capacity) && capacity >= 1 && capacity <= 32,
    `configured ceiling ${Number.isFinite(capacity) ? capacity : 'invalid'}`);
  add('identity-issuer', Boolean(output(cognito, 'Issuer') && output(cognito, 'ClientId')
    && output(cognito, 'JwksUrl')), 'staging Cognito issuer and client configured');
  const indexes = new Map(runLedgerTable?.GlobalSecondaryIndexes?.map(item =>
    [item.IndexName, item.IndexStatus]) ?? []);
  add('run-ledger-indexes', runLedgerTable?.TableStatus === 'ACTIVE'
    && indexes.get('gsi1') === 'ACTIVE' && indexes.get('DeletionDueIndex') === 'ACTIVE',
  'run ledger and both required indexes ACTIVE');
  const container = taskDefinition?.containerDefinitions?.find(item => item.name === 'browser-worker');
  const env = new Map(container?.environment?.map(item => [item.name, item.value]) ?? []);
  const image = parameter(preview, 'BrowserImageUri');
  const immutableImage = typeof image === 'string'
    && /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/.+@sha256:[a-f0-9]{64}$/.test(image);
  add('preview-task-safe-mode', Boolean(taskDefinition && container && immutableImage
    && container.image === image
    && taskDefinition.taskDefinitionArn === output(preview, 'TaskDefinitionArn')
    && taskDefinition.taskRoleArn === output(preview, 'TaskRoleArn')
    && taskDefinition.executionRoleArn === output(preview, 'ExecutionRoleArn')
    && env.get('OPENAPPLY_CLOUD_TASK_MODE') === 'preview'
    && env.get('OPENAPPLY_CLOUD_PREVIEW_ONLY') === '1'
    && env.get('OPENAPPLY_SUBMISSION_MODE') === 'disabled'),
  'immutable preview image and employer submission disabled');
  return { scope: 'structural-prerequisites-only', inventoryComplete: checks.every(item => item.ok), checks };
}

function awsJson(region, args) {
  try {
    return JSON.parse(execFileSync('aws', [...args, '--region', region, '--output', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }));
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    if (stderr.includes('ValidationError') && stderr.includes('does not exist')) return null;
    throw new Error(`AWS read failed for ${args[0]} ${args[1]}: ${stderr.trim() || error.message}`);
  }
}

export function collectPreviewInventory(region) {
  const accountId = awsJson(region, ['sts', 'get-caller-identity'])?.Account;
  const stacks = Object.fromEntries(Object.entries(stackNames).map(([key, name]) =>
    [key, awsJson(region, ['cloudformation', 'describe-stacks', '--stack-name', name])?.Stacks?.[0] ?? null]));
  const taskArn = output(stacks.preview, 'TaskDefinitionArn');
  const taskDefinition = taskArn ? awsJson(region, ['ecs', 'describe-task-definition',
    '--task-definition', taskArn])?.taskDefinition : null;
  const ledgerName = output(stacks.control, 'RunLedgerName');
  const runLedgerTable = ledgerName ? awsJson(region, ['dynamodb', 'describe-table',
    '--table-name', ledgerName])?.Table : null;
  return { accountId, stacks, taskDefinition, runLedgerTable };
}

function main(args) {
  const option = name => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const region = option('--region') || 'us-east-1';
  const expectedAccountId = option('--account-id');
  if (!/^\d{12}$/.test(expectedAccountId ?? '')) {
    throw new Error('Usage: node scripts/aws-preview-launcher-preflight.mjs --account-id 123456789012 [--region us-east-1] [--json]');
  }
  const inventory = collectPreviewInventory(region);
  const result = assessPreviewLauncher(inventory.accountId, expectedAccountId,
    inventory.stacks, inventory.taskDefinition, inventory.runLedgerTable);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else for (const item of result.checks) {
    process.stdout.write(`${item.ok ? 'PASS' : 'BLOCK'} ${item.gate}: ${item.detail}\n`);
  }
  process.exitCode = result.inventoryComplete ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
