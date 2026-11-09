package com.craniumiot.cranium.core

/** Whose account took the password on the one sign-in screen. */
enum class SignInAccount { TEAM, CUSTOMER }

/**
 * One sign-in for everybody (customer-core.js signInEither): the e-mail address and the password go
 * to the team's pool first, with the phone apps' client of it, and only if it says the address or the
 * password is wrong, to the customer pool, the same way. One submission tries each pool once at most,
 * and a refusal by both is the one "wrong e-mail address or password", whichever pool has the account.
 * "Forgot your password?" asks both pools too, one request each.
 */
object OneSignIn {
    /** One pool's USER_SRP_AUTH: the address (lowercased by the sign-in itself) and the password. */
    fun interface Attempt {
        suspend fun signIn(email: String, password: String): SignInStep
    }

    /** The team's pool first, then the customer pool; either may be missing from the build. */
    suspend fun first(team: Attempt?, customer: Attempt?, email: String, password: String): Pair<SignInAccount, SignInStep> {
        var refused: Pair<SignInAccount, SignInStep>? = null
        for ((account, attempt) in listOf(SignInAccount.TEAM to team, SignInAccount.CUSTOMER to customer)) {
            if (attempt == null) continue
            val step = attempt.signIn(email, password)
            if (step is SignInStep.Password && step.problem == "wrong-password") {
                refused = account to step
                continue
            }
            return account to step
        }
        return refused ?: (SignInAccount.CUSTOMER to SignInStep.Password("failed"))
    }

    /**
     * The code of a reset: both pools, one request each. The team's pool hides unknown names and says a
     * code went out, so its yes proves nothing and the customer pool is always asked as well.
     */
    suspend fun forgotPassword(team: CustomerAccount?, customer: CustomerAccount?, email: String): AccountResult<Unit> =
        either(listOfNotNull(team, customer), stopAtFirst = false) { it.forgotPassword(email) }

    /** The code and the new password: the team's pool first; a yes there settles it. */
    suspend fun confirmForgotPassword(
        team: CustomerAccount?,
        customer: CustomerAccount?,
        email: String,
        code: String,
        password: String,
    ): AccountResult<Unit> = either(listOfNotNull(team, customer), stopAtFirst = true) { it.confirmForgotPassword(email, code, password) }

    private suspend fun either(
        accounts: List<CustomerAccount>,
        stopAtFirst: Boolean,
        call: suspend (CustomerAccount) -> AccountResult<Unit>,
    ): AccountResult<Unit> {
        val problems = mutableListOf<String>()
        var ok = false
        for (account in accounts) {
            when (val result = call(account)) {
                is AccountResult.Ok -> {
                    ok = true
                    if (stopAtFirst) return result
                }
                is AccountResult.Failed -> {
                    // Asked of neither pool: an address left empty, a code too short.
                    if (result.problem == "missing-email" || result.problem == "short-code") return result
                    problems += result.problem
                }
            }
        }
        return if (ok) AccountResult.Ok(Unit) else AccountResult.Failed(plainest(problems))
    }

    /**
     * Of the pools' refusals, the one to show: a specific one before "that code is not right", which is
     * also what a pool says of an address it does not have (customer-core.js plainestProblem).
     */
    fun plainest(problems: List<String>): String {
        val vague = setOf("wrong-code", "failed", "session-ended")
        return problems.firstOrNull { it !in vague } ?: problems.lastOrNull() ?: "failed"
    }
}
