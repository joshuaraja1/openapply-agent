import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { updateParameters } from './aws-synthetic-drill-rollback.mjs';

test('rollback replaces only requested launcher parameters', () => {
  const current = [
    { ParameterKey: 'MaxConcurrentBrowserTasks', ParameterValue: '2' },
    { ParameterKey: 'EcsTaskDefinitionArn', ParameterValue: 'synthetic' },
    { ParameterKey: 'DeletionStopGateReady', ParameterValue: 'true' },
  ];
  assert.deepEqual(updateParameters(current, {
    MaxConcurrentBrowserTasks: '1', EcsTaskDefinitionArn: 'preview',
  }), [
    { ParameterKey: 'MaxConcurrentBrowserTasks', ParameterValue: '1' },
    { ParameterKey: 'EcsTaskDefinitionArn', ParameterValue: 'preview' },
    { ParameterKey: 'DeletionStopGateReady', UsePreviousValue: true },
  ]);
  assert.throws(() => updateParameters(current, { Unknown: 'value' }), /unavailable/);
});
