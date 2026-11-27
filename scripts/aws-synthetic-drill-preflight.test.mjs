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
  const setOutput = (key, name, value) => {
    stacks[key].Outputs.find((item) => item.OutputKey === name).OutputValue = value;
  };
  const setParameter = (key, name, value) => {
    stacks[key].Parameters.push({ ParameterKey: name, ParameterValue: value });
  };
  setOutput('controlPlane', 'PrivateArtifactsBucket', 'fixture-bucket');
  setOutput('browserSmoke', 'ClusterArn', 'arn:aws:ecs:us-east-1:123456789012:cluster/staging');
  setOutput('onboarding', 'CandidateDataKeyArn', 'arn:aws:kms:us-east-1:123456789012:key/key-id');
  setOutput('broker', 'BrokerFunctionArn', 'arn:aws:lambda:us-east-1:123456789012:function:broker');
  setOutput('syntheticTask', 'TaskDefinitionArn', 'arn:aws:ecs:us-east-1:123456789012:task-definition/synthetic:1');
  setOutput('syntheticTask', 'TaskRoleArn', 'arn:aws:iam::123456789012:role/synthetic');
  setOutput('egress', 'PrivateSubnetId', 'subnet-12345678');
  for (const [name, value] of [
    ['EcsClusterArn', stacks.browserSmoke.Outputs.find((item) => item.OutputKey === 'ClusterArn').OutputValue],
    ['EcsTaskDefinitionArn', stacks.syntheticTask.Outputs.find((item) => item.OutputKey === 'TaskDefinitionArn').OutputValue],
    ['EcsTaskRoleArn', stacks.syntheticTask.Outputs.find((item) => item.OutputKey === 'TaskRoleArn').OutputValue],
    ['PrivateSubnetIds', 'subnet-12345678'],
  ]) setParameter('launcher', name, value);
  for (const key of ['broker', 'syntheticTask']) {
    setParameter(key, 'ArtifactKmsKeyArn', stacks.onboarding.Outputs[0].OutputValue);
    setParameter(key, 'ArtifactBucketName', 'fixture-bucket');
  }
  setParameter('syntheticTask', 'ArtifactBrokerArn', stacks.broker.Outputs[0].OutputValue);
  setParameter('syntheticTask', 'ExecutionRoleArn', 'arn:aws:iam::123456789012:role/execution');
  const task = { taskRoleArn: 'arn:aws:iam::123456789012:role/synthetic',
    executionRoleArn: 'arn:aws:iam::123456789012:role/execution',
    containerDefinitions: [{ name: 'browser-worker', environment: [
      { name: 'OPENAPPLY_CLOUD_TASK_MODE', value: 'synthetic' },
      { name: 'OPENAPPLY_CLOUD_SYNTHETIC_ONLY', value: '1' },
      { name: 'OPENAPPLY_ENABLE_CLOUD_QUEUE_TASK', value: '1' },
      { name: 'OPENAPPLY_SUBMISSION_MODE', value: 'disabled' },
    ], image: `example.dkr.ecr.us-east-1.amazonaws.com/openapply@sha256:${'a'.repeat(64)}` }] };
  return { stacks, task };
}

test('blocks a missing tenant boundary, deletion gate, or safe task mode', () => {
  const { stacks, task } = readyFixture();
  delete stacks.broker;
  stacks.onboarding.Parameters = stacks.onboarding.Parameters.filter(
    (item) => item.ParameterKey !== 'EnableDeletionEcsStop');
  task.containerDefinitions[0].environment.find((item) =>
    item.name === 'OPENAPPLY_SUBMISSION_MODE').value = 'live';
  const result = assessInventory('123456789012', '123456789012', stacks, task);
  assert.equal(result.inventoryComplete, false);
  assert.deepEqual(result.checks.filter((check) => !check.ok).map((check) => check.gate),
    ['onboarding', 'broker', 'synthetic-task-mode']);
});

test('blocks wrong account even when staging resources appear ready', () => {
  const { stacks, task } = readyFixture();
  const result = assessInventory('999999999999', '123456789012', stacks, task);
  assert.equal(result.inventoryComplete, false);
  assert.equal(result.checks[0].gate, 'account');
});

test('permits a synthetic drill only when all declared prerequisites exist', () => {
  const { stacks, task } = readyFixture();
  const result = assessInventory('123456789012', '123456789012', stacks, task);
  assert.equal(result.inventoryComplete, true);
  assert.equal(result.scope, 'structural-prerequisites-only');
  assert.ok(result.checks.every((check) => check.ok));
});

test('rejects a mutable or unrelated browser image', () => {
  const { stacks, task } = readyFixture();
  task.containerDefinitions[0].image = 'example.dkr.ecr.us-east-1.amazonaws.com/openapply:latest';
  const result = assessInventory('123456789012', '123456789012', stacks, task);
  assert.equal(result.inventoryComplete, false);
  assert.equal(result.checks.find((check) => check.gate === 'synthetic-task-mode').ok, false);
});

test('rejects launcher or broker wired to another staging resource', () => {
  const { stacks, task } = readyFixture();
  stacks.launcher.Parameters.find((item) => item.ParameterKey === 'PrivateSubnetIds')
    .ParameterValue = 'subnet-other';
  stacks.syntheticTask.Parameters.find((item) => item.ParameterKey === 'ArtifactBrokerArn')
    .ParameterValue = 'arn:aws:lambda:us-east-1:123456789012:function:other';
  const result = assessInventory('123456789012', '123456789012', stacks, task);
  assert.equal(result.inventoryComplete, false);
  assert.match(result.checks.find((check) => check.gate === 'stack-wiring').detail,
    /launcher.PrivateSubnetIds.*syntheticTask.ArtifactBrokerArn/);
});

test('rejects a task with wrong entrypoint mode or a different task role', () => {
  const { stacks, task } = readyFixture();
  task.containerDefinitions[0].environment.find((item) =>
    item.name === 'OPENAPPLY_ENABLE_CLOUD_QUEUE_TASK').value = '0';
  task.taskRoleArn = 'arn:aws:iam::123456789012:role/broad';
  const result = assessInventory('123456789012', '123456789012', stacks, task);
  assert.equal(result.inventoryComplete, false);
  assert.equal(result.checks.find((check) => check.gate === 'synthetic-task-mode').ok, false);
});
