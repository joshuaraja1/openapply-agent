import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessPreviewLauncher } from './aws-preview-launcher-preflight.mjs';

const accountId = '205064803661';
const stack = (outputs = {}, parameters = {}) => ({ StackStatus: 'CREATE_COMPLETE',
  Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
  Parameters: Object.entries(parameters).map(([ParameterKey, ParameterValue]) =>
    ({ ParameterKey, ParameterValue })) });
const image = `${accountId}.dkr.ecr.us-east-1.amazonaws.com/openapply-staging-browser@sha256:${'a'.repeat(64)}`;
function fixture() {
  const stacks = {
    control: stack({ PrivateArtifactsBucket: 'bucket', RunLedgerName: 'ledger' }),
    billing: stack({ EntitlementTableName: 'entitlements' }),
    browser: stack({ ClusterArn: 'cluster', EgressOnlySecurityGroupId: 'sg' }),
    cognito: stack({ Issuer: 'issuer', ClientId: 'client', JwksUrl: 'jwks' }),
    onboarding: stack({ CandidateDataKeyArn: 'key' }),
    broker: stack({ BrokerFunctionArn: 'broker' }),
    preview: stack({ TaskDefinitionArn: 'task', TaskRoleArn: 'role', ExecutionRoleArn: 'execution' },
      { EnablePreviewTask: 'true', BrowserImageUri: image, ArtifactBucketName: 'bucket',
        ArtifactKmsKeyArn: 'key', ArtifactBrokerArn: 'broker' }),
    launcher: stack({}, { EnableFargateLauncher: 'true', DeletionStopGateReady: 'true',
      MaxConcurrentBrowserTasks: '1', EcsClusterArn: 'cluster', EcsTaskDefinitionArn: 'task',
      EcsTaskRoleArn: 'role', EcsExecutionRoleArn: 'execution', EcsSecurityGroupId: 'sg',
      PrivateSubnetIds: 'subnet', RunLedgerTableName: 'ledger',
      EntitlementTableName: 'entitlements' }),
    egress: stack({ PrivateSubnetId: 'subnet' }),
  };
  const task = { taskDefinitionArn: 'task', taskRoleArn: 'role', executionRoleArn: 'execution',
    containerDefinitions: [{ name: 'browser-worker', image, environment: [
      { name: 'OPENAPPLY_CLOUD_TASK_MODE', value: 'preview' },
      { name: 'OPENAPPLY_CLOUD_PREVIEW_ONLY', value: '1' },
      { name: 'OPENAPPLY_SUBMISSION_MODE', value: 'disabled' },
    ] }] };
  const ledger = { TableStatus: 'ACTIVE', GlobalSecondaryIndexes: [
    { IndexName: 'gsi1', IndexStatus: 'ACTIVE' },
    { IndexName: 'DeletionDueIndex', IndexStatus: 'ACTIVE' },
  ] };
  return { stacks, task, ledger };
}

test('accepts linked immutable preview resources with submissions disabled', () => {
  const { stacks, task, ledger } = fixture();
  assert.equal(assessPreviewLauncher(accountId, accountId, stacks, task, ledger).inventoryComplete, true);
});

test('blocks account, task-mode, linkage, and capacity drift', () => {
  const { stacks, task, ledger } = fixture();
  const controls = task.containerDefinitions[0].environment;
  controls.find(item => item.name === 'OPENAPPLY_SUBMISSION_MODE').value = 'enabled';
  stacks.launcher.Parameters.find(item => item.ParameterKey === 'EcsTaskDefinitionArn').ParameterValue = 'wrong';
  stacks.launcher.Parameters.find(item => item.ParameterKey === 'MaxConcurrentBrowserTasks').ParameterValue = '33';
  ledger.GlobalSecondaryIndexes[0].IndexStatus = 'CREATING';
  const result = assessPreviewLauncher('wrong', accountId, stacks, task, ledger);
  assert.equal(result.inventoryComplete, false);
  for (const gate of ['account', 'resource-links', 'bounded-capacity', 'preview-task-safe-mode',
    'run-ledger-indexes']) {
    assert.equal(result.checks.find(item => item.gate === gate)?.ok, false);
  }
});
