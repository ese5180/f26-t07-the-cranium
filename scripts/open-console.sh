#!/usr/bin/env bash
#
# Bring up the Cranium firmware console on AWS and open it in the browser.
#
#   scripts/open-console.sh              sign in if needed, deploy if needed, open the page
#   scripts/open-console.sh --update     also deploy the code in this checkout first
#   scripts/open-console.sh --no-open    do everything except open the browser
#
# There is no server to start: the console runs on Lambda and API Gateway, which answer
# whenever someone asks and cost next to nothing in between. So "on" means that the stack
# exists and answers. If the AWS session has run out, this signs in through the browser.
# If the stack does not exist, this creates it with cloud/deploy.sh, which takes a few
# minutes. A console created that way is empty: give yourself an account and provision
# the boards again, as deploy.sh explains when it finishes. The way to turn it all off
# is cloud/teardown.sh, which deletes everything the console stored.
#
# The profile and the Region come from AWS_PROFILE and AWS_REGION (default cranium and
# us-east-1). Needs the AWS CLI v2 and curl, and for a deployment what cloud/deploy.sh
# lists.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK=cranium-ota
STACK_WAIT_SECONDS=1200
ANSWER_WAIT_SECONDS=120

export AWS_PROFILE="${AWS_PROFILE:-cranium}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
export AWS_PAGER=""

die() {
  printf 'error: %s\n' "$1" >&2
  shift
  if [ $# -gt 0 ]; then
    printf '       %s\n' "$@" >&2
  fi
  exit 1
}

# The comment block at the top of this file.
usage() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

sign_in() {
  if aws sts get-caller-identity > /dev/null 2>&1; then
    return 0
  fi
  echo "The AWS session for profile $AWS_PROFILE has run out. Signing in through the browser."
  aws login --profile "$AWS_PROFILE" --region "$AWS_REGION" \
    || die "the sign-in to AWS did not complete" \
      "Run it yourself: aws login --profile $AWS_PROFILE --region $AWS_REGION"
  aws sts get-caller-identity > /dev/null 2>&1 \
    || die "the sign-in finished, but AWS still does not accept profile $AWS_PROFILE"
}

# Prints the status of the stack, or NONE when it does not exist.
stack_status() {
  local out
  if out="$(aws cloudformation describe-stacks --stack-name "$STACK" \
      --query 'Stacks[0].StackStatus' --output text 2>&1)"; then
    printf '%s\n' "$out"
    return 0
  fi
  case "$out" in
    *"does not exist"*) printf 'NONE\n' ;;
    *) die "could not read the state of stack $STACK" "$out" ;;
  esac
}

# Prints the status once no operation is running on the stack any more.
settled_status() {
  local status waited=0
  status="$(stack_status)"
  while [[ "$status" == *_IN_PROGRESS ]]; do
    [ "$waited" -lt "$STACK_WAIT_SECONDS" ] \
      || die "stack $STACK is still $status after $STACK_WAIT_SECONDS s"
    echo "Stack $STACK is $status. Waiting for it to finish." >&2
    sleep 15
    waited=$((waited + 15))
    status="$(stack_status)"
  done
  printf '%s\n' "$status"
}

deploy() {
  "$REPO_DIR/cloud/deploy.sh" || die "the deployment failed; see the output above"
}

console_url() {
  local url
  url="$(aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='ConsoleUrl'].OutputValue | [0]" --output text)" \
    || die "could not read the address of the console from stack $STACK"
  case "$url" in
    https://*) printf '%s\n' "$url" ;;
    *) die "stack $STACK does not name the address of the console (got: $url)" ;;
  esac
}

# A new deployment can take a moment before it answers.
wait_for_answer() {
  local url="$1" code waited=0
  while true; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$url" 2>/dev/null || true)"
    [ "$code" = 200 ] && return 0
    [ "$waited" -lt "$ANSWER_WAIT_SECONDS" ] \
      || die "the console at $url does not answer (last HTTP status: ${code:-none})" \
        "Run cloud/smoke.sh and cloud/logs.sh web to see why."
    sleep 5
    waited=$((waited + 5))
  done
}

open_page() {
  if command -v open > /dev/null; then
    open "$1"
  elif command -v xdg-open > /dev/null; then
    xdg-open "$1"
  else
    echo "No way to open a browser was found here: open the address above yourself."
  fi
}

main() {
  local update=false open_browser=true status url
  while [ $# -gt 0 ]; do
    case "$1" in
      --update) update=true ;;
      --no-open) open_browser=false ;;
      -h|--help)
        usage
        return 0
        ;;
      *) die "unknown argument: $1" "See scripts/open-console.sh --help." ;;
    esac
    shift
  done

  command -v aws > /dev/null || die "the AWS CLI is not installed"
  command -v curl > /dev/null || die "curl is not installed"

  sign_in

  status="$(settled_status)"
  case "$status" in
    NONE)
      echo "Stack $STACK does not exist. Deploying the console; this takes a few minutes."
      deploy
      ;;
    CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE|IMPORT_ROLLBACK_COMPLETE)
      if [ "$update" = true ]; then
        echo "Deploying the code in this checkout."
        deploy
      fi
      ;;
    *)
      die "stack $STACK is in state $status, which cannot serve the console" \
        "Run cloud/deploy.sh, or look at the stack's events in the AWS console."
      ;;
  esac

  url="$(console_url)"
  wait_for_answer "$url"
  echo "The console is up: $url"
  if [ "$open_browser" = true ]; then
    open_page "$url"
  fi
}

main "$@"
