import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { assessInventory, defaultStacks } from './aws-synthetic-drill-preflight.mjs';

function readyFixture() {
  const outputs = {
    controlPlane: ['RunLedgerName', 'PrivateArtifactsBucket'],
    billing: ['EntitlementTableName', 'EntitlementTableArn'],
    browserSmoke: ['ClusterArn', 'RepositoryUri'],
    code: ['CodeBucketName'], cognito: ['Issuer', 'ClientId', 'JwksUrl'],
    onboarding: ['CandidateDataKeyArn'], broker: ['BrokerFunctionArn'],
    syntheticTask: ['TaskDefinitionArn', 'TaskRoleArn'],
    launcher: ['LauncherFunctionArn'], egress: ['PrivateSubnetId'],
  };
  const parameters = {
    onboarding: ['EnableOnboarding', 'EnableCandidateDeletion',
      'EnableDeletionRetry', 'EnableDeletionEcsStop'],
    syntheticTask: ['EnableSyntheticQueueTask'],
    launcher: ['EnableFargateLauncher', 'DeletionStopGateReady'],
    egress: ['EnableBrowserEgress'],
  };
  const stacks = Object.fromEntries(Object.keys(defaultStacks).map((key) => [key, {
    StackStatus: 'CREATE_COMPLETE',
    Outputs: (outputs[key] ?? []).map((OutputKey) => ({ OutputKey,
      OutputValue: OutputKey === 'RepositoryUri' ? 'example.dkr.ecr.us-east-1.amazonaws.com/openapply'
        : 'value' })),
    Parameters: (parameters[key] ?? []).map((ParameterKey) =>
      ({ ParameterKey, ParameterValue: 'true' })),
  }]));
  const task = { taskRoleArn: 'arn:aws:iam::123456789012:role/synthetic',
    executionRoleArn: 'arn:aws:iam::123456789012:role/execution',
    containerDefinitions: [{ name: 'browser-worker', environment: [
      { name: 'OPENAPPLY_CLOUD_SYNTHETIC_ONLY', value: '1' },
      { name: 'OPENAPPLY_SUBMISSION_MODE', value: 'disabled' },
    ], image: `example.dkr.ecr.us-east-1.amazonaws.com/openapply@sha256:${'a'.repeat(64)}` }] };
  return { stacks, task };
}

test('blocks a missing tenant boundary, deletion gate, or safe task mode', () => {
  const { stacks, task } = readyFixture();
  delete stacks.broker;
  stacks.onboarding.Parameters = stacks.onboarding.Parameters.filter(
    (item) => item.ParameterKey !== 'EnableDeletionEcsStop');
  task.containerDefinitions[0].environment[1].value = 'live';
  const result = assessInventory('123456789012', '123456789012', stacks, task);
  assert.equal(result.ready, false);
  assert.deepEqual(result.checks.filter((check) => !check.ok).map((check) => check.gate),
    ['onboarding', 'broker', 'synthetic-task-mode']);
});

test('blocks wrong account even when staging resources appear ready', () => {
  const { stacks, task } = readyFixture();
  const result = assessInventory('999999999999', '123456789012', stacks, task);
  assert.equal(result.ready, false);
  assert.equal(result.checks[0].gate, 'account');
});

test('permits a synthetic drill only when all declared prerequisites exist', () => {
  const { stacks, task } = readyFixture();
  const result = assessInventory('123456789012', '123456789012', stacks, task);
  assert.equal(result.ready, true);
  assert.ok(result.checks.every((check) => check.ok));
});

test('rejects a mutable or unrelated browser image', () => {
  const { stacks, task } = readyFixture();
  task.containerDefinitions[0].image = 'example.dkr.ecr.us-east-1.amazonaws.com/openapply:latest';
  const result = assessInventory('123456789012', '123456789012', stacks, task);
  assert.equal(result.ready, false);
  assert.equal(result.checks.find((check) => check.gate === 'synthetic-task-mode').ok, false);
});
