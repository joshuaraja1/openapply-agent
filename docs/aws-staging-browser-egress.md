# Private browser task egress in staging

The Fargate launcher sets `AssignPublicIp: DISABLED`. The current staging VPC
has only public subnets and no NAT gateway or VPC endpoints. A task configured
with those subnets cannot pull its ECR image or reach the external HTTPS sites
used during validation. The optional
`deploy/aws/staging-browser-egress.yaml` stack creates one private subnet and
a NAT gateway for outbound traffic. Its default `EnableBrowserEgress=false`
creates no resources. The stack is not deployed.

Before enabling it, confirm that `PrivateSubnetCidr` is unused in `VpcId`,
that `PublicSubnetId` is in the same VPC and has a route to an internet gateway,
and that `AvailabilityZone` matches that public subnet. A NAT gateway and
Elastic IP have standing and data-processing charges while provisioned; set a
cost alarm and tear down the stack after the staging drill if it is no longer
needed. One availability zone is sufficient for the first disposable synthetic
test. Multi-zone production networking requires a separate design and budget.

Use the `PrivateSubnetId` output in the launcher `PrivateSubnetIds` parameter.
Keep `AssignPublicIp: DISABLED` and the egress-only security group. Verify an
immutable ECR image pull, CloudWatch log delivery, AWS service calls, and a
controlled outbound HTTPS request from a disposable synthetic task before
enabling the application launcher. This network stack does not grant any
candidate-data permissions or enable a browser task by itself.

## November 27 staging drill

The template was deployed temporarily in the staging VPC with
`PrivateSubnetCidr=172.31.96.0/24`. The existing no-candidate-data smoke task
ran with `AssignPublicIp=DISABLED` in that private subnet. ECS reported exit
code 0 and CloudWatch logged `Cloud browser smoke passed`. The temporary stack
was deleted afterward; AWS reported its NAT gateway deleted and the private
subnet absent. This verifies private image pull, logging, and Chromium startup.
It does not verify an application task, the tenant broker, external employer
sites, or production network capacity.
