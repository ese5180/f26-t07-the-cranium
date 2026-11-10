# Accounts: the Team page, and customers' accounts

From console 2.17.0 a release manager manages the people who sign in to the console from the console itself, on the
Team page (`#/team`, under More on a phone), and the Customers page shows how each customer's account stands, with
more of what can be done to it. `cloud/users.sh` still does the same from a terminal.

The console never sees, sets or shows a password. Cognito makes every temporary password and e-mails it; a reset of a
customer's password is Cognito's own, by a code it e-mails.

## Who may

Release managers only, on the website: a viewer is refused, and so is an API token or a phone app's session, for
reading as for changing (the routes are `token: false, phone: false` in `cloud/api/src/app.mjs`, like the Customers
page). Every change asks Cognito, at that moment, whether the caller is still an enabled, confirmed release manager
(`requireLiveWriter`, `cloud/api/src/auth.mjs`), whatever the token says.

## The Team page

Every account of the staff pool: its e-mail address, its tier (release manager, viewer, or none if it is in neither
group), whether it is enabled, whether it has signed in with its own password (Active), is still Invited, or has to
choose a new password (Reset), whether an authenticator app is set up, when it was added, and when it last signed in.
Cognito does not say when a user of this pool last signed in, so that time is the newest sign-in the activity log
holds for the account (`account.sign_in`, the last 200 sign-ins). The list has a search and filters by tier and status
([search-filters.md](search-filters.md)).

| Action | What happens | Activity log |
| --- | --- | --- |
| Invite | Cognito makes the account, e-mails the invitation with a temporary password (3 days), and the account is put in the group of its tier | `account.invite` |
| Send the invitation again | While the person has not signed in yet; the earlier temporary password stops working | `account.resend` |
| Make release manager / Make viewer | The new group is added before the old one is removed, so the account is never without a tier | `account.tier` |
| Disable / Enable | A disabled account cannot sign in, and stops reading within a minute | `account.disable`, `account.enable` |
| Reset password and authenticator | The account is replaced: signed out, deleted, and made again with the same tier; Cognito e-mails a new invitation | `account.reset` |
| Remove | Signed out everywhere and deleted | `account.remove` |

Each goes through a dialog that says what follows; Disable, Make viewer, Reset and Remove are marked as destructive.
Each entry records what changed, before and after ([audit-diff.md](audit-diff.md)): the tier, the account's state, the
authenticator. Never a password.

### Why a reset replaces the account

The staff pool requires an authenticator app (`MfaConfiguration: 'ON'`) and lets only an administrator recover an
account (`AccountRecoverySetting: admin_only`). So:

- Cognito's admin reset (`AdminResetUserPassword`) cannot be used: it needs self-service recovery, by which it would
  e-mail a code. The console may not set a password instead.
- An authenticator cannot be removed while MFA is required, and setting the MFA preference does not forget the app
  that is registered.

A reset therefore does what `cloud/users.sh reset-mfa` does: it replaces the account, with its tier, and Cognito
e-mails a new invitation. The person chooses a new password and sets up a new authenticator at the next sign-in, in
one step. The new account has a new id: the old sessions can change nothing at once, and earlier entries of the
activity log keep the old id. If a reset stops between the delete and the new invitation, invite the person again.

## Guards

- Nobody demotes, disables, resets or removes their own account (`own_account`). The page offers nothing on your own
  row.
- There is always at least one enabled, confirmed release manager: a change that would take the last one away is
  refused (`last_release_manager`), counted from Cognito at the moment of the change. The page does not offer it.
- A pending account cannot be reset (send the invitation again), a disabled one cannot be reset (enable it first),
  and an account with no tier cannot be reset (give it one first).

## The Customers page

Each customer now shows whether they set up an authenticator app (theirs to choose), next to whether they are switched
on and have signed in. Besides inviting, giving boards and switching accounts off and on:

| Action | What happens | Activity log |
| --- | --- | --- |
| Reset password | Cognito's admin reset: the old password stops working and Cognito e-mails a code to choose a new one with (the customer pool's recovery is by e-mail). Not for an invited customer, nor a switched-off one | `customer.reset_password` |
| Remove | Signed out everywhere and deleted. Boards still given to the account stay listed under it, as gone, to be taken back | `customer.remove` |

Both ask a second time before they act.

## IAM

The API function's role (`cloud/infra/template.yaml`, `ApiRole`) has, besides the live check's `AdminGetUser` and
`AdminListGroupsForUser`:

- `ManageTeam`, on the staff pool only: `ListUsers`, `AdminCreateUser`, `AdminAddUserToGroup`,
  `AdminRemoveUserFromGroup`, `AdminDisableUser`, `AdminEnableUser`, `AdminUserGlobalSignOut`, `AdminDeleteUser`.
- `ManageCustomers`, on the customer pool only: what it had, and `AdminResetUserPassword`, `AdminUserGlobalSignOut`,
  `AdminDeleteUser`.

Nothing sets a password or an attribute, or changes MFA or a pool: `cloud/api/test/infra.test.mjs` checks it. No
function gained a setting.

## Code

| Part | Where |
| --- | --- |
| The routes | `cloud/api/src/handlers/team.mjs`, `cloud/api/src/handlers/customers.mjs` |
| Cognito | `cloud/api/src/aws-team.mjs` (staff pool), `cloud/api/src/customer/aws.mjs` (customer pool) |
| The pages | `cloud/web/src/site/assets/team.js`, `customers.js` |
| Tests | `cloud/api/test/team.test.mjs`, `customers.test.mjs`, `aws.test.mjs`, `infra.test.mjs`; `cloud/web/test/team.test.mjs` |
