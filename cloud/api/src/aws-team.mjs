/**
 * The team's accounts, for the console's Team page (handlers/team.mjs, docs/accounts.md): the staff user
 * pool, the one people sign in to the console with. Like src/aws.mjs, the only place for these calls to
 * import the AWS SDK, with its helpers: the same timeouts, the same errors (name "AwsError", code
 * "throttled" | "failed") and the same plain values. test/fake-aws.mjs implements it in memory; keep the
 * two in step. It reads AWS_REGION and USER_POOL_ID.
 *
 * An account's id is its sub. The groups of an account are read with listUserGroups (src/aws.mjs).
 *
 *   listTeam()                     -> [{ sub, email, name, enabled, status, createdAt, mfa: null }]  every
 *                                     account, any order; createdAt in epoch ms or null. ListUsers does not
 *                                     say whether an authenticator is set up
 *   getTeamMember(sub)             -> the same, with mfa true | false, or null
 *   inviteTeamMember({ email })    -> { ok: true, member } | { ok: false, reason: "exists" }
 *                                     Cognito makes the account and e-mails the invitation, with a
 *                                     temporary password this code never sees or sets
 *   resendTeamInvitation(email)    -> { ok: true } | { ok: false, reason: "not_found" | "not_invited" }
 *   addTeamMemberToGroup(sub, group) / removeTeamMemberFromGroup(sub, group)
 *                                  -> { ok: true } | { ok: false, reason: "not_found" }
 *   setTeamMemberEnabled(sub, enabled)
 *                                  -> { ok: true } | { ok: false, reason: "not_found" }
 *   deleteTeamMember(sub)          -> { ok: true } | { ok: false, reason: "not_found" }  signs the account
 *                                     out everywhere first, then deletes it
 *
 * Nothing here sets, reads or resets a password: the pool's recovery is for an administrator only, so
 * Cognito's admin reset has no code to send, and a new password always comes from a new invitation.
 */

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';

import { clientSettings, everyPage, failure, millis, nameOf, required } from './aws.mjs';

// The largest page of ListUsers.
const USER_PAGE_SIZE = 60;

/** The value of one attribute of a Cognito user, or ''. */
function attribute(attributes, name) {
  const value = (attributes ?? []).find((item) => item?.Name === name)?.Value;
  return typeof value === 'string' ? value : '';
}

/** A Cognito user in plain values. `mfa` is null where Cognito's answer does not say. */
export function memberOf({ attributes, enabled, status, created, username, mfaList }) {
  return {
    sub: attribute(attributes, 'sub') || (typeof username === 'string' ? username : ''),
    email: attribute(attributes, 'email'),
    name: attribute(attributes, 'name') || attribute(attributes, 'given_name'),
    enabled: enabled === true,
    status: typeof status === 'string' ? status : '',
    createdAt: millis(created),
    mfa: Array.isArray(mfaList) ? mfaList.includes('SOFTWARE_TOKEN_MFA') : mfaList === null ? false : null,
  };
}

/**
 * @param {Record<string, string|undefined>} env  the Lambda environment
 */
export function createTeamStore(env) {
  const region = required(env, 'AWS_REGION');
  const poolId = required(env, 'USER_POOL_ID');
  const cognito = new CognitoIdentityProviderClient(clientSettings(region));

  /** One call that changes an account: { ok } or not_found; any other failure is thrown. */
  async function change(operation, command) {
    try {
      await cognito.send(command);
      return { ok: true };
    } catch (cause) {
      if (nameOf(cause) === 'UserNotFoundException') return { ok: false, reason: 'not_found' };
      throw failure(operation, cause);
    }
  }

  return Object.freeze({
    async listTeam() {
      try {
        return await everyPage('ListUsers', async (PaginationToken) => {
          const out = await cognito.send(
            new ListUsersCommand({ UserPoolId: poolId, Limit: USER_PAGE_SIZE, PaginationToken })
          );
          const items = (out.Users ?? [])
            .map((user) =>
              memberOf({
                attributes: user?.Attributes,
                enabled: user?.Enabled,
                status: user?.UserStatus,
                created: user?.UserCreateDate,
                username: user?.Username,
              })
            )
            .filter((member) => member.sub !== '');
          return { items, next: out.PaginationToken };
        });
      } catch (cause) {
        throw nameOf(cause) === 'AwsError' ? cause : failure('ListUsers', cause);
      }
    },

    async getTeamMember(sub) {
      try {
        const out = await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: sub }));
        return memberOf({
          attributes: out.UserAttributes,
          enabled: out.Enabled,
          status: out.UserStatus,
          created: out.UserCreateDate,
          username: out.Username,
          // No list at all is an account with no MFA set up.
          mfaList: Array.isArray(out.UserMFASettingList) ? out.UserMFASettingList : null,
        });
      } catch (cause) {
        if (nameOf(cause) === 'UserNotFoundException') return null;
        throw failure('AdminGetUser', cause);
      }
    },

    async inviteTeamMember({ email }) {
      try {
        const out = await cognito.send(
          new AdminCreateUserCommand({
            UserPoolId: poolId,
            Username: email,
            UserAttributes: [
              { Name: 'email', Value: email },
              { Name: 'email_verified', Value: 'true' },
            ],
            DesiredDeliveryMediums: ['EMAIL'],
          })
        );
        const user = out.User ?? {};
        return {
          ok: true,
          member: memberOf({
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

    async resendTeamInvitation(email) {
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

    async addTeamMemberToGroup(sub, group) {
      return change(
        'AdminAddUserToGroup',
        new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: sub, GroupName: group })
      );
    },

    async removeTeamMemberFromGroup(sub, group) {
      return change(
        'AdminRemoveUserFromGroup',
        new AdminRemoveUserFromGroupCommand({ UserPoolId: poolId, Username: sub, GroupName: group })
      );
    },

    async setTeamMemberEnabled(sub, enabled) {
      const Command = enabled ? AdminEnableUserCommand : AdminDisableUserCommand;
      return change(
        enabled ? 'AdminEnableUser' : 'AdminDisableUser',
        new Command({ UserPoolId: poolId, Username: sub })
      );
    },

    async deleteTeamMember(sub) {
      // Signed out first, so that no refresh token of the account outlives it. A failure here does not
      // stop the delete, which ends the account's tokens as well.
      try {
        await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: poolId, Username: sub }));
      } catch (cause) {
        if (nameOf(cause) === 'UserNotFoundException') return { ok: false, reason: 'not_found' };
      }
      return change('AdminDeleteUser', new AdminDeleteUserCommand({ UserPoolId: poolId, Username: sub }));
    },
  });
}
