// The commands of @aws-sdk/client-iot that only src/aws-provision.mjs sends, with their input members as
// the command sources of the AWS SDK for JavaScript v3 (3.1149.0) have them. aws.test.mjs adds them to its
// stand-in of the package, so that index.mjs loads; provision-aws.test.mjs holds the adapter to them.
//
// This file is test code. It is never packaged with the function.

export const PROVISION_COMMANDS = Object.freeze({
  AddThingToThingGroupCommand: {
    required: [],
    optional: ['thingGroupName', 'thingGroupArn', 'thingName', 'thingArn', 'overrideDynamicGroups'],
  },
  AttachPolicyCommand: { required: ['policyName', 'target'], optional: [] },
  AttachThingPrincipalCommand: { required: ['thingName', 'principal'], optional: ['thingPrincipalType'] },
  CreateCertificateFromCsrCommand: { required: ['certificateSigningRequest'], optional: ['setAsActive'] },
  CreateThingCommand: { required: ['thingName'], optional: ['thingTypeName', 'attributePayload', 'billingGroupName'] },
  DeleteCertificateCommand: { required: ['certificateId'], optional: ['forceDelete'] },
  DescribeEndpointCommand: { required: [], optional: ['endpointType'] },
  DetachPolicyCommand: { required: ['policyName', 'target'], optional: [] },
  DetachThingPrincipalCommand: { required: ['thingName', 'principal'], optional: [] },
  UpdateCertificateCommand: { required: ['certificateId', 'newStatus'], optional: [] },
  UpdateThingCommand: {
    required: ['thingName'],
    optional: ['thingTypeName', 'attributePayload', 'expectedVersion', 'removeThingType'],
  },
});
