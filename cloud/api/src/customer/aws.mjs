/**
 * The AWS adapters of the customer site (docs/customer-site.md). Like src/aws.mjs, the only
 * place here that imports the AWS SDK, and with its helpers: the same timeouts, the same
 * errors (name "AwsError", code "throttled" | "failed") and the same plain values.
 * test/fake-customers.mjs implements both interfaces in memory; keep the three in step.
 *
 * createCustomerStore(env): the customer pool and who owns which board. Used by the console's
 * API (the Customers page, release managers only) and by the customer API (each customer's
 * own record). It reads AWS_REGION, STATE_TABLE and CUSTOMER_POOL_ID.
 *
 *   Customers (the customer user pool, apart from the staff pool; a customer's id is its sub)
 *     listCustomers()           -> [{ sub, email, name, enabled, status, createdAt, mfa: null }]  every
 *                                  one, any order; createdAt in epoch ms or null
 *     getCustomer(sub)          -> the same shape, with mfa true | false, | null
 *     inviteCustomer({ email, name })
 *                               -> { ok: true, customer } | { ok: false, reason: "exists" }
 *                                  Cognito makes the account and e-mails the invitation, with a
 *                                  temporary password this code never sees
 *     resendInvitation(email)   -> { ok: true } | { ok: false, reason: "not_found" | "not_invited" }
 *     setCustomerEnabled(sub, enabled)
 *                               -> { ok: true } | { ok: false, reason: "not_found" }
 *     resetCustomerPassword(sub) -> { ok: true } | { ok: false, reason: "not_found" | "not_allowed" }
 *                                  Cognito's admin reset: the old password stops working and Cognito
 *                                  e-mails a code to choose a new one with. Never a password here
 *     deleteCustomer(sub)       -> { ok: true } | { ok: false, reason: "not_found" }  signed out, then deleted
 *
 *   Ownership (state table, pk "OWN", sk = the thing name; a board has one owner at most)
 *     listOwnership()           -> [{ thing, owner, ref, label, customerLabel, assignedAt, assignedBy }]
 *                                  the owned boards only, any order; consistent read. `label` is the
 *                                  admin's, `customerLabel` the owner's own name for it ('' for none)
 *     setCustomerLabel({ thing, owner, ref, label, at })
 *                               -> { ok: true } | { ok: false, reason: "not_owner" }  only while `owner`
 *                                  owns it under that assignment id; '' takes the name away. Never the
 *                                  thing name, the owner or the admin's label
 *     assignBoard({ thing, owner, ref, label, at, by })
 *                               -> { ok: true } | { ok: false, reason: "taken" }  only a board
 *                                  that nobody owns; `at` is an ISO time, `by` the admin's sub
 *     unassignBoard({ thing, owner, at })
 *                               -> { ok: true } | { ok: false, reason: "not_owner" }  only while
 *                                  `owner` owns it. The item stays, with no owner: the API role may
 *                                  not delete from the state table
 *
 *   Preferences (state table, pk "PRF", sk = the customer's sub): the e-mails a customer wants
 *     getPreferences(sub)       -> { offline, updated, unexpectedRestart, updatedAt } | null  (none chosen)
 *     setPreferences(sub, { offline, updated, unexpectedRestart }, at)
 *                               -> { ok: true }  all three booleans, each written as given
 *
 * createCustomerActionLog(env): what customers did, in the audit table's partition "CUS" and no other
 * (lib/audit.mjs). It reads AWS_REGION and AUDIT_TABLE.
 *
 *     putCustomerAction(item)   -> { ok: true } | { ok: false, reason: "exists" }  never over another
 *     recentCustomerActions({ sub, since })
 *                               -> [sk]  the keys of this customer's entries from `since` (an ISO time) on
 *
 * createBoardReader(env): what the customer API reads about a board, and nothing more. It reads
 * AWS_REGION and EVENTS_TABLE.
 *
 *     getShadow(thing)          -> as in src/aws.mjs
 *     queryEvents({ thing, low, high, kinds, limit })
 *                               -> as in src/aws.mjs, without tags
 */

import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminResetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { GetThingShadowCommand, IoTDataPlaneClient } from '@aws-sdk/client-iot-data-plane';

import {
  clientSettings,
  everyPage,
  failure,
  fromItem,
  millis,
  nameOf,
  queryEventTable,
  required,
  statusOf,
  toItem,
} from '../aws.mjs';

import { CUSTOMER_ACTIONS_PK } from '../lib/audit.mjs';

export const OWNERSHIP_PK = 'OWN';
export const PREFERENCES_PK = 'PRF';
// The most pages of the customer partition one count of recent actions reads.
const MAX_ACTION_PAGES = 10;
// The largest page of ListUsers.
const USER_PAGE_SIZE = 60;
const MAX_KINDS = 16;

/** The value of one attribute of a Cognito user, or ''. */
function attribute(attributes, name) {
  const value = (attributes ?? []).find((item) => item?.Name === name)?.Value;
  return typeof value === 'string' ? value : '';
}

/** A Cognito user, as AdminGetUser, ListUsers and AdminCreateUser describe one, in plain values. */
function customerOf({ attributes, enabled, status, created, username, mfaList }) {
  return {
    sub: attribute(attributes, 'sub') || (typeof username === 'string' ? username : ''),
    email: attribute(attributes, 'email'),
    name: attribute(attributes, 'name'),
    enabled: enabled === true,
    status: typeof status === 'string' ? status : '',
    createdAt: millis(created),
    // Whether an authenticator app is set up: AdminGetUser says, ListUsers does not (null).
    mfa: Array.isArray(mfaList) ? mfaList.includes('SOFTWARE_TOKEN_MFA') : mfaList === null ? false : null,
  };
}

/** An item of the ownership partition, or null if it is not an owned board. */
function ownershipOf(item) {
  if (typeof item?.sk !== 'string' || typeof item.owner !== 'string' || item.owner === '') return null;
  return {
    thing: item.sk,
    owner: item.owner,
    ref: typeof item.ref === 'string' ? item.ref : '',
    label: typeof item.label === 'string' ? item.label : '',
    customerLabel: typeof item.customerLabel === 'string' ? item.customerLabel : '',
    assignedAt: typeof item.assignedAt === 'string' ? item.assignedAt : null,
    assignedBy: typeof item.assignedBy === 'string' ? item.assignedBy : '',
  };
}

/**
 * @param {Record<string, string|undefined>} env  the Lambda environment
 */
export function createCustomerStore(env) {
  const region = required(env, 'AWS_REGION');
  const stateTable = required(env, 'STATE_TABLE');
  const poolId = required(env, 'CUSTOMER_POOL_ID');
  const cognito = new CognitoIdentityProviderClient(clientSettings(region));
  const dynamo = new DynamoDBClient(clientSettings(region));

  return Object.freeze({
    async listCustomers() {
      try {
        return await everyPage('ListUsers', async (PaginationToken) => {
          const out = await cognito.send(
            new ListUsersCommand({ UserPoolId: poolId, Limit: USER_PAGE_SIZE, PaginationToken })
          );
          const items = (out.Users ?? [])
            .map((user) =>
              customerOf({
                attributes: user?.Attributes,
                enabled: user?.Enabled,
                status: user?.UserStatus,
                created: user?.UserCreateDate,
                username: user?.Username,
              })
            )
            .filter((customer) => customer.sub !== '');
          return { items, next: out.PaginationToken };
        });
      } catch (cause) {
        throw nameOf(cause) === 'AwsError' ? cause : failure('ListUsers', cause);
      }
    },

    async getCustomer(sub) {
      try {
        const out = await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: sub }));
        return customerOf({
          attributes: out.UserAttributes,
          enabled: out.Enabled,
          status: out.UserStatus,
          created: out.UserCreateDate,
          username: out.Username,
          mfaList: Array.isArray(out.UserMFASettingList) ? out.UserMFASettingList : null,
        });
      } catch (cause) {
        if (nameOf(cause) === 'UserNotFoundException') return null;
        throw failure('AdminGetUser', cause);
      }
    },

    async inviteCustomer({ email, name }) {
      const attributes = [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ];
      if (name) attributes.push({ Name: 'name', Value: name });
      try {
        const out = await cognito.send(
          new AdminCreateUserCommand({
            UserPoolId: poolId,
            Username: email,
            UserAttributes: attributes,
            DesiredDeliveryMediums: ['EMAIL'],
          })
        );
        const user = out.User ?? {};
        return {
          ok: true,
          customer: customerOf({
            attributes: user.Attributes,
            enabled: user.Enabled,
            status: user.UserStatus,
            created: user.UserCreateDate,
            username: user.Username,
            mfaList: null,
          }),
        };
      } catch (cause) {
        if (nameOf(cause) === 'UsernameExistsException' || nameOf(cause) === 'AliasExistsException') {
          return { ok: false, reason: 'exists' };
        }
        throw failure('AdminCreateUser', cause);
      }
    },

    async resendInvitation(email) {
      try {
        await cognito.send(
          new AdminCreateUserCommand({
            UserPoolId: poolId,
            Username: email,
            MessageAction: 'RESEND',
            DesiredDeliveryMediums: ['EMAIL'],
          })
        );
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'UserNotFoundException') return { ok: false, reason: 'not_found' };
        if (nameOf(cause) === 'UnsupportedUserStateException') return { ok: false, reason: 'not_invited' };
        throw failure('AdminCreateUser', cause);
      }
    },

    async setCustomerEnabled(sub, enabled) {
      const Command = enabled ? AdminEnableUserCommand : AdminDisableUserCommand;
      try {
        await cognito.send(new Command({ UserPoolId: poolId, Username: sub }));
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'UserNotFoundException') return { ok: false, reason: 'not_found' };
        throw failure(enabled ? 'AdminEnableUser' : 'AdminDisableUser', cause);
      }
    },

    async resetCustomerPassword(sub) {
      try {
        await cognito.send(new AdminResetUserPasswordCommand({ UserPoolId: poolId, Username: sub }));
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'UserNotFoundException') return { ok: false, reason: 'not_found' };
        // An account that has not chosen a password yet, or has no verified address to send the code to.
        if (nameOf(cause) === 'NotAuthorizedException' || nameOf(cause) === 'InvalidParameterException') {
          return { ok: false, reason: 'not_allowed' };
        }
        throw failure('AdminResetUserPassword', cause);
      }
    },

    async deleteCustomer(sub) {
      // Signed out first, so that no refresh token outlives the account; the delete goes on regardless.
      try {
        await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: poolId, Username: sub }));
      } catch (cause) {
        if (nameOf(cause) === 'UserNotFoundException') return { ok: false, reason: 'not_found' };
      }
      try {
        await cognito.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: sub }));
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'UserNotFoundException') return { ok: false, reason: 'not_found' };
        throw failure('AdminDeleteUser', cause);
      }
    },

    async listOwnership() {
      try {
        const items = [];
        let start;
        for (let pages = 0; pages < 40; pages += 1) {
          const out = await dynamo.send(
            new QueryCommand({
              TableName: stateTable,
              KeyConditionExpression: '#pk = :pk',
              ExpressionAttributeNames: { '#pk': 'pk' },
              ExpressionAttributeValues: { ':pk': { S: OWNERSHIP_PK } },
              ConsistentRead: true,
              ExclusiveStartKey: start,
            })
          );
          for (const item of out.Items ?? []) items.push(fromItem(item));
          if (out.LastEvaluatedKey === undefined || out.LastEvaluatedKey === null) {
            return items.map(ownershipOf).filter((item) => item !== null);
          }
          start = out.LastEvaluatedKey;
        }
        throw new Error('more than 40 pages');
      } catch (cause) {
        throw failure('Query', cause);
      }
    },

    async assignBoard({ thing, owner, ref, label, at, by }) {
      const item = { pk: OWNERSHIP_PK, sk: thing, owner, ref, assignedAt: at, assignedBy: by };
      if (label) item.label = label;
      try {
        await dynamo.send(
          new PutItemCommand({
            TableName: stateTable,
            Item: toItem(item),
            // A board nobody owns: never seen, or given back. Never one somebody owns.
            ConditionExpression: 'attribute_not_exists(#sk) OR attribute_not_exists(#owner)',
            ExpressionAttributeNames: { '#sk': 'sk', '#owner': 'owner' },
          })
        );
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'ConditionalCheckFailedException') return { ok: false, reason: 'taken' };
        throw failure('PutItem', cause);
      }
    },

    async unassignBoard({ thing, owner, at }) {
      try {
        await dynamo.send(
          new UpdateItemCommand({
            TableName: stateTable,
            Key: toItem({ pk: OWNERSHIP_PK, sk: thing }),
            UpdateExpression:
              'REMOVE #owner, #ref, #label, #customerLabel, #labelledAt, #assignedAt, #assignedBy SET #unassignedAt = :at',
            ConditionExpression: '#owner = :owner',
            ExpressionAttributeNames: {
              '#owner': 'owner',
              '#ref': 'ref',
              '#label': 'label',
              '#customerLabel': 'customerLabel',
              '#labelledAt': 'labelledAt',
              '#assignedAt': 'assignedAt',
              '#assignedBy': 'assignedBy',
              '#unassignedAt': 'unassignedAt',
            },
            ExpressionAttributeValues: { ':owner': { S: owner }, ':at': { S: at } },
          })
        );
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'ConditionalCheckFailedException') return { ok: false, reason: 'not_owner' };
        throw failure('UpdateItem', cause);
      }
    },

    async setCustomerLabel({ thing, owner, ref, label, at }) {
      const names = {
        '#owner': 'owner',
        '#ref': 'ref',
        '#customerLabel': 'customerLabel',
        '#labelledAt': 'labelledAt',
      };
      const values = { ':owner': { S: owner }, ':ref': { S: ref }, ':at': { S: at } };
      let update = 'REMOVE #customerLabel SET #labelledAt = :at';
      if (label) {
        update = 'SET #customerLabel = :label, #labelledAt = :at';
        values[':label'] = { S: label };
      }
      try {
        await dynamo.send(
          new UpdateItemCommand({
            TableName: stateTable,
            Key: toItem({ pk: OWNERSHIP_PK, sk: thing }),
            UpdateExpression: update,
            // Only the owner, and only under the assignment they were given: a board taken back and
            // given again has another id, and the update makes no item that does not exist.
            ConditionExpression: '#owner = :owner AND #ref = :ref',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          })
        );
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'ConditionalCheckFailedException') return { ok: false, reason: 'not_owner' };
        throw failure('UpdateItem', cause);
      }
    },

    async getPreferences(sub) {
      let out;
      try {
        out = await dynamo.send(
          new GetItemCommand({
            TableName: stateTable,
            Key: toItem({ pk: PREFERENCES_PK, sk: sub }),
            ConsistentRead: true,
          })
        );
      } catch (cause) {
        throw failure('GetItem', cause);
      }
      if (!out.Item) return null;
      const item = fromItem(out.Item);
      return {
        offline: item.offline === true,
        updated: item.updated === true,
        unexpectedRestart: item.unexpectedRestart === true,
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : null,
      };
    },

    async setPreferences(sub, { offline, updated, unexpectedRestart }, at) {
      try {
        await dynamo.send(
          new UpdateItemCommand({
            TableName: stateTable,
            Key: toItem({ pk: PREFERENCES_PK, sk: sub }),
            UpdateExpression: 'SET #offline = :offline, #updated = :updated, #restart = :restart, #at = :at',
            ExpressionAttributeNames: {
              '#offline': 'offline',
              '#updated': 'updated',
              '#restart': 'unexpectedRestart',
              '#at': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':offline': { BOOL: offline === true },
              ':updated': { BOOL: updated === true },
              ':restart': { BOOL: unexpectedRestart === true },
              ':at': { S: at },
            },
          })
        );
        return { ok: true };
      } catch (cause) {
        throw failure('UpdateItem', cause);
      }
    },
  });
}

/**
 * @param {Record<string, string|undefined>} env  the Lambda environment
 */
export function createCustomerActionLog(env) {
  const region = required(env, 'AWS_REGION');
  const auditTable = required(env, 'AUDIT_TABLE');
  const dynamo = new DynamoDBClient(clientSettings(region));

  return Object.freeze({
    async putCustomerAction(item) {
      try {
        await dynamo.send(
          new PutItemCommand({
            TableName: auditTable,
            Item: toItem({ ...item, pk: CUSTOMER_ACTIONS_PK }),
            ConditionExpression: 'attribute_not_exists(#pk)',
            ExpressionAttributeNames: { '#pk': 'pk' },
          })
        );
        return { ok: true };
      } catch (cause) {
        if (nameOf(cause) === 'ConditionalCheckFailedException') return { ok: false, reason: 'exists' };
        throw failure('PutItem', cause);
      }
    },

    async recentCustomerActions({ sub, since }) {
      const keys = [];
      let start;
      try {
        for (let pages = 0; pages < MAX_ACTION_PAGES; pages += 1) {
          const out = await dynamo.send(
            new QueryCommand({
              TableName: auditTable,
              KeyConditionExpression: '#pk = :pk AND #sk >= :since',
              FilterExpression: '#actor.#sub = :sub',
              ProjectionExpression: '#sk',
              ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk', '#actor': 'actor', '#sub': 'sub' },
              ExpressionAttributeValues: {
                ':pk': { S: CUSTOMER_ACTIONS_PK },
                ':since': { S: since },
                ':sub': { S: sub },
              },
              ConsistentRead: true,
              ExclusiveStartKey: start,
            })
          );
          for (const item of out.Items ?? []) if (typeof item.sk?.S === 'string') keys.push(item.sk.S);
          if (out.LastEvaluatedKey === undefined || out.LastEvaluatedKey === null) return keys;
          start = out.LastEvaluatedKey;
        }
      } catch (cause) {
        throw failure('Query', cause);
      }
      // More than that in the window is more than any limit allows: count it as full.
      return keys;
    },
  });
}

/**
 * @param {Record<string, string|undefined>} env  the Lambda environment
 */
export function createBoardReader(env) {
  const region = required(env, 'AWS_REGION');
  const eventsTable = required(env, 'EVENTS_TABLE');
  const iotData = new IoTDataPlaneClient(clientSettings(region));
  const dynamo = new DynamoDBClient(clientSettings(region));

  return Object.freeze({
    async getShadow(thing) {
      let payload;
      try {
        ({ payload } = await iotData.send(new GetThingShadowCommand({ thingName: thing })));
      } catch (cause) {
        if (nameOf(cause) === 'ResourceNotFoundException' || statusOf(cause) === 404) return null;
        throw failure('GetThingShadow', cause);
      }
      try {
        return JSON.parse(Buffer.from(payload ?? []).toString('utf8'));
      } catch {
        throw failure('GetThingShadow', new Error('the shadow is not valid JSON'), 'failed');
      }
    },

    async queryEvents({ thing, low, high, kinds = null, limit }) {
      if (kinds !== null && (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > MAX_KINDS)) {
        throw new TypeError('kinds must be null or a list of 1 to 16 kinds');
      }
      try {
        return await queryEventTable(dynamo, eventsTable, { thing, low, high, kinds, limit, forward: false });
      } catch (cause) {
        throw failure('Query', cause);
      }
    },
  });
}
