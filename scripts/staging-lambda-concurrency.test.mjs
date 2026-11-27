import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

for (const [file, parameter, condition] of [
  ['deploy/aws/artifact-credential-broker.yaml', 'BrokerReservedConcurrentExecutions', 'BrokerReservationEnabled'],
  ['deploy/aws/fargate-launcher-staging.yaml', 'LauncherReservedConcurrentExecutions', 'LauncherReservationEnabled'],
]) {
  test(`${file} does not reserve unavailable Lambda capacity by default`, () => {
    const template = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(template, new RegExp(`  ${parameter}:\\n    Type: Number\\n    Default: 0\\n`));
    assert.match(template, new RegExp(`  ${condition}: !Not \\[!Equals \\[!Ref ${parameter}, 0\\]\\]`));
    assert.match(template, new RegExp(`ReservedConcurrentExecutions: !If \\[${condition}, !Ref ${parameter}, !Ref 'AWS::NoValue'\\]`));
    assert.doesNotMatch(template, /ReservedConcurrentExecutions: [1-9][0-9]*\s*$/m);
  });
}
