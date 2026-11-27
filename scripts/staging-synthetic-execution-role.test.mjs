import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const template = readFileSync(new URL('../deploy/aws/synthetic-queue-task.yaml', import.meta.url), 'utf8');

test('synthetic browser has a dedicated execution role for only its image and logs', () => {
  const execution = template.split('  SyntheticQueueExecutionRole:\n')[1]
    ?.split('  SyntheticQueueTaskRole:\n')[0];
  const task = template.split('  SyntheticQueueTask:\n')[1]?.split('\nOutputs:')[0];
  assert.ok(execution);
  assert.ok(task);
  assert.match(execution, /Action: ecr:GetAuthorizationToken\n\s+Resource: '\*'/);
  assert.match(execution, /Resource: !Sub 'arn:\$\{AWS::Partition\}:ecr:\$\{AWS::Region\}:\$\{AWS::AccountId\}:repository\/openapply-staging-browser'/);
  assert.match(execution, /Action:\n\s+- logs:CreateLogStream\n\s+- logs:PutLogEvents/);
  assert.match(execution, /Resource: !Sub 'arn:\$\{AWS::Partition\}:logs:\$\{AWS::Region\}:\$\{AWS::AccountId\}:log-group:\/openapply\/staging\/synthetic-queue:\*'/);
  assert.match(task, /ExecutionRoleArn: !GetAtt SyntheticQueueExecutionRole\.Arn/);
  assert.match(template, /  ExecutionRoleArn:\n\s+Condition: TaskEnabled\n\s+Value: !GetAtt SyntheticQueueExecutionRole\.Arn/);
});

test('application task role still grants only the named broker invocation', () => {
  const role = template.split('  SyntheticQueueTaskRole:\n')[1]
    ?.split('  SyntheticQueueTask:\n')[0];
  assert.ok(role);
  assert.match(role, /Action: lambda:InvokeFunction\n\s+Resource: !Ref ArtifactBrokerArn/);
  const permissions = role.split('      Policies:\n')[1];
  assert.doesNotMatch(permissions, /Action:\s*(?:\[)?(?:dynamodb:|sqs:|s3:|kms:|sts:AssumeRole)/);
});
