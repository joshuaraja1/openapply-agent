#!/usr/bin/env node
/** Read-only gate for the disposable hosted AWS browser drill. */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const defaultStacks = {
  controlPlane: 'openapply-staging-control-plane',
  billing: 'openapply-billing-staging',
  browserSmoke: 'openapply-staging-browser-smoke',
  code: 'openapply-staging-code',
  cognito: 'openapply-staging-cognito',
  onboarding: 'openapply-staging-onboarding',
  broker: 'openapply-staging-artifact-broker',
  syntheticTask: 'openapply-staging-synthetic-queue',
  launcher: 'openapply-staging-fargate-launcher',
  egress: 'openapply-staging-browser-egress',
};

const requirements = {
  controlPlane: { outputs: ['RunLedgerName', 'PrivateArtifactsBucket'] },
  billing: { outputs: ['EntitlementTableName', 'EntitlementTableArn'] },
  browserSmoke: { outputs: ['ClusterArn', 'RepositoryUri', 'EgressOnlySecurityGroupId'] },
  code: { outputs: ['CodeBucketName'] },
  cognito: { outputs: ['Issuer', 'ClientId', 'JwksUrl'] },
  onboarding: { outputs: ['CandidateDataKeyArn'], parameters: {
    EnableOnboarding: 'true', EnableCandidateDeletion: 'true',
    EnableDeletionRetry: 'true', EnableDeletionEcsStop: 'true' } },
  broker: { outputs: ['BrokerFunctionArn'] },
  syntheticTask: { outputs: ['TaskDefinitionArn', 'TaskRoleArn'], parameters: {
    EnableSyntheticQueueTask: 'true' } },
  launcher: { outputs: ['LauncherFunctionArn'], parameters: {
    EnableFargateLauncher: 'true', DeletionStopGateReady: 'true' } },
  egress: { outputs: ['PrivateSubnetId'], parameters: { EnableBrowserEgress: 'true' } },
};

export function assessInventory(accountId, expectedAccountId, stacks, taskDefinition,
  runLedgerTable) {
  const checks = [];
  checks.push({ gate: 'account', ok: accountId === expectedAccountId,
    detail: accountId === expectedAccountId ? 'expected account' : 'AWS account mismatch' });
  for (const [key, requirement] of Object.entries(requirements)) {
    const stack = stacks[key];
    if (!stack) {
      checks.push({ gate: key, ok: false, detail: 'stack missing' });
      continue;
    }
    if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus)) {
      checks.push({ gate: key, ok: false, detail: `stack ${stack.StackStatus}` });
      continue;
    }
    const outputs = new Set((stack.Outputs ?? []).map((item) => item.OutputKey));
    const params = new Map((stack.Parameters ?? []).map((item) =>
      [item.ParameterKey, item.ParameterValue]));
    const missing = requirement.outputs.filter((output) => !outputs.has(output));
    const disabled = Object.entries(requirement.parameters ?? {}).filter(
      ([name, value]) => params.get(name) !== value).map(([name]) => name);
    checks.push({ gate: key, ok: missing.length === 0 && disabled.length === 0,
      detail: missing.length || disabled.length
        ? [...missing.map((name) => `missing ${name}`),
          ...disabled.map((name) => `${name} not enabled`)].join(', ')
        : 'ready' });
  }
  const indexNames = ['gsi1', 'DeletionDueIndex'];
  const indexes = new Map((runLedgerTable?.GlobalSecondaryIndexes ?? []).map((index) =>
    [index.IndexName, index.IndexStatus]));
  const indexProblems = !runLedgerTable ? ['table missing']
    : [runLedgerTable.TableStatus === 'ACTIVE' ? null : `table ${runLedgerTable.TableStatus}`,
      ...indexNames.map((name) => indexes.get(name) === 'ACTIVE' ? null
        : indexes.has(name) ? `${name} ${indexes.get(name)}` : `missing ${name}`)]
      .filter(Boolean);
  checks.push({ gate: 'run-ledger-indexes', ok: indexProblems.length === 0,
    detail: indexProblems.length ? indexProblems.join(', ') : 'both indexes ACTIVE' });
  if (stacks.syntheticTask) {
    const browser = (taskDefinition?.containerDefinitions ?? [])
      .find((item) => item.name === 'browser-worker');
    const env = new Map(browser?.environment?.map((item) => [item.name, item.value]) ?? []);
    const repository = stacks.browserSmoke?.Outputs?.find((item) =>
      item.OutputKey === 'RepositoryUri')?.OutputValue;
    const immutableImage = repository && browser?.image?.startsWith(`${repository}@sha256:`)
      && /^[a-f0-9]{64}$/.test(browser.image.slice(`${repository}@sha256:`.length));
    const taskRole = stacks.syntheticTask?.Outputs?.find((item) =>
      item.OutputKey === 'TaskRoleArn')?.OutputValue;
    const executionRole = stacks.syntheticTask?.Parameters?.find((item) =>
      item.ParameterKey === 'ExecutionRoleArn')?.ParameterValue;
    const safe = taskRole && taskDefinition?.taskRoleArn === taskRole
      && executionRole && taskDefinition?.executionRoleArn === executionRole
      && immutableImage
      && env.get('OPENAPPLY_CLOUD_TASK_MODE') === 'synthetic'
      && env.get('OPENAPPLY_CLOUD_SYNTHETIC_ONLY') === '1'
      && env.get('OPENAPPLY_ENABLE_CLOUD_QUEUE_TASK') === '1'
      && env.get('OPENAPPLY_SUBMISSION_MODE') === 'disabled'
      && ['', 'after_intent', 'after_click', 'after_confirmation']
        .includes(env.get('OPENAPPLY_SYNTHETIC_CRASH_AT') ?? '');
    checks.push({ gate: 'synthetic-task-mode', ok: Boolean(safe),
      detail: safe ? 'immutable image, synthetic only, real submission disabled'
        : 'task definition lacks an immutable reviewed image, roles, or safe mode settings' });
  }
  const output = (key, name) => stacks[key]?.Outputs?.find((item) =>
    item.OutputKey === name)?.OutputValue;
  const parameter = (key, name) => stacks[key]?.Parameters?.find((item) =>
    item.ParameterKey === name)?.ParameterValue;
  if (['controlPlane', 'browserSmoke', 'onboarding', 'broker', 'syntheticTask',
    'launcher', 'egress'].every((key) => stacks[key])) {
    const links = [
      ['launcher', 'EcsClusterArn', output('browserSmoke', 'ClusterArn')],
      ['launcher', 'EcsTaskDefinitionArn', output('syntheticTask', 'TaskDefinitionArn')],
      ['launcher', 'EcsTaskRoleArn', output('syntheticTask', 'TaskRoleArn')],
      ['launcher', 'EcsExecutionRoleArn', taskDefinition?.executionRoleArn],
      ['launcher', 'EcsSecurityGroupId', output('browserSmoke', 'EgressOnlySecurityGroupId')],
      ['launcher', 'PrivateSubnetIds', output('egress', 'PrivateSubnetId')],
      ['broker', 'ArtifactKmsKeyArn', output('onboarding', 'CandidateDataKeyArn')],
      ['broker', 'ArtifactBucketName', output('controlPlane', 'PrivateArtifactsBucket')],
      ['syntheticTask', 'ArtifactKmsKeyArn', output('onboarding', 'CandidateDataKeyArn')],
      ['syntheticTask', 'ArtifactBucketName', output('controlPlane', 'PrivateArtifactsBucket')],
      ['syntheticTask', 'ArtifactBrokerArn', output('broker', 'BrokerFunctionArn')],
    ];
    const bad = links.filter(([key, name, value]) => !value || parameter(key, name) !== value)
      .map(([key, name]) => `${key}.${name}`);
    checks.push({ gate: 'stack-wiring', ok: bad.length === 0,
      detail: bad.length ? `mismatched ${bad.join(', ')}` : 'exact resource links' });
  }
  return { scope: 'structural-prerequisites-only',
    inventoryComplete: checks.every((check) => check.ok), checks };
}

function awsJson(region, args) {
  try {
    return JSON.parse(execFileSync('aws', [...args, '--region', region, '--output', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }));
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    if ((stderr.includes('ValidationError') && stderr.includes('does not exist'))
      || (args[0] === 'dynamodb' && stderr.includes('ResourceNotFoundException'))) return null;
    throw new Error(`AWS read failed for ${args[0]} ${args[1]}: ${stderr.trim() || error.message}`);
  }
}

export function collectInventory(region, stackNames = defaultStacks) {
  const accountId = awsJson(region, ['sts', 'get-caller-identity'])?.Account;
  const stacks = {};
  for (const [key, name] of Object.entries(stackNames)) {
    stacks[key] = awsJson(region, ['cloudformation', 'describe-stacks',
      '--stack-name', name])?.Stacks?.[0] ?? null;
  }
  const taskArn = stacks.syntheticTask?.Outputs?.find((item) =>
    item.OutputKey === 'TaskDefinitionArn')?.OutputValue;
  const taskDefinition = taskArn ? awsJson(region, ['ecs', 'describe-task-definition',
    '--task-definition', taskArn])?.taskDefinition : null;
  const ledgerName = stacks.controlPlane?.Outputs?.find((item) =>
    item.OutputKey === 'RunLedgerName')?.OutputValue;
  const runLedgerTable = ledgerName ? awsJson(region, ['dynamodb', 'describe-table',
    '--table-name', ledgerName])?.Table : null;
  return { accountId, stacks, taskDefinition, runLedgerTable };
}

function main(args) {
  const option = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const region = option('--region') || 'us-east-1';
  const expectedAccountId = option('--account-id');
  if (!/^\d{12}$/.test(expectedAccountId ?? '')) {
    throw new Error('Usage: node scripts/aws-synthetic-drill-preflight.mjs --account-id 123456789012 [--region us-east-1] [--json]');
  }
  const inventory = collectInventory(region);
  const result = assessInventory(inventory.accountId, expectedAccountId,
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
