package com.craniumiot.cranium.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.craniumiot.cranium.core.CodeEntry
import com.craniumiot.cranium.core.CustomerText
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.SignInWords
import com.craniumiot.cranium.core.Tone

private const val SIGN_IN_LEAD = "With your e-mail address, your password and the code from your authenticator app."

/** The sign-in at the start: the app's own screen, the way the console's own page does it. */
@Composable
fun SignInGate(vm: ConsoleViewModel, gate: Gate.SignIn, form: SignInForm) {
    val colors = console
    Column(
        Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(Gutter),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
            BrandMark()
            Column {
                Text("Cranium", style = ConsoleType.sectionTitle.copy(fontSize = 19.sp), color = colors.ink)
                Text("Firmware console", style = ConsoleType.note, color = colors.ink3)
            }
        }
        Spacer(Modifier.height(12.dp))
        if (vm.exampleConfig) {
            OneLine("This build has the example configuration, so sign-in will not work.", tone = Tone.WARN, glyph = Glyph.ALERT)
        }
        if (gate.busy != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = colors.accent)
                Text(gate.busy, style = ConsoleType.body, color = colors.ink2)
            }
        } else {
            gate.notice?.let { notice ->
                Notice(
                    Tone.BAD, Glyph.ALERT, notice,
                    action = if (notice.startsWith("Signed in, but")) ({ ConsoleButton("Try again", vm::retryStart, small = true) }) else null,
                )
            }
            SignInSteps(vm, form, lead = SIGN_IN_LEAD)
        }
        // Admin mode's own sign-in, after a session that ended there: the way back to the one sign-in of the customer side.
        LocalAdminExits.current?.let { exits ->
            HorizontalDivider(color = colors.line)
            ConsoleButton(
                CustomerText.LEAVE_ADMIN_MODE, exits.leave, kind = ButtonKind.QUIET, glyph = Glyph.ARROW_LEFT, small = true,
                enabled = gate.busy == null && !form.busy,
            )
        }
    }
}

/** How admin mode is left for the customer side: from the console's More and Account, and its sign-in. */
class AdminExits(val leave: () -> Unit)

val LocalAdminExits = androidx.compose.runtime.staticCompositionLocalOf<AdminExits?> { null }

/** The fresh sign-in a change waits for: the same screen over the console, with the address fixed. */
@Composable
fun FreshSignInDialog(vm: ConsoleViewModel, form: SignInForm) {
    Dialog(
        onDismissRequest = vm::cancelFresh,
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnBackPress = true, dismissOnClickOutside = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = console.paper, contentColor = console.ink) {
            Column(
                Modifier
                    .fillMaxSize()
                    .windowInsetsPadding(WindowInsets.safeDrawing)
                    .imePadding()
                    .verticalScroll(rememberScrollState())
                    .padding(Gutter),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = vm::cancelFresh) { GlyphIcon(Glyph.X, description = "Cancel, and make no change") }
                    Spacer(Modifier.width(4.dp))
                    BrandMark(24.dp)
                }
                SignInSteps(vm, form, lead = "A change from the phone needs a sign-in in the last 15 minutes.")
            }
        }
    }
}

/** The steps of the sign-in: the password, then the code. Nothing here keeps the password. */
@Composable
private fun SignInSteps(vm: ConsoleViewModel, form: SignInForm, lead: String) {
    val colors = console
    val fresh = form.fresh
    if (form.leaving != null) {
        Text("Taking you to the AWS sign-in page…", style = ConsoleType.pageTitle.copy(fontSize = 26.sp), color = colors.ink)
        if (form.leaving.isNotEmpty()) Text(form.leaving, style = ConsoleType.body, color = colors.ink2)
        CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp, color = colors.accent)
        return
    }
    val code = form.phase == SignInPhase.CODE
    Text(
        if (code) "Enter the code" else if (fresh) "Sign in again" else "Sign in",
        style = ConsoleType.pageTitle, color = colors.ink,
    )
    Text(if (code) "Signing in as ${form.email}." else lead, style = ConsoleType.body, color = colors.ink2)
    if (code) CodeStep(vm, form) else PasswordStep(vm, form)
    HorizontalDivider(color = colors.line)
    Column {
        ConsoleButton("Use the AWS sign-in page", { vm.useAwsPage(fresh) }, kind = ButtonKind.QUIET, glyph = Glyph.ARROW_RIGHT, small = true, enabled = !form.busy)
        Text("The same account and the same code, on Amazon’s page.", Modifier.padding(start = 12.dp), style = ConsoleType.note, color = colors.ink3)
    }
}

@Composable
private fun ProblemLine(form: SignInForm) {
    val problem = form.problem ?: return
    // A new line for every answer, so that the same problem twice is said twice.
    key(form.tries) {
        Row(
            Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Assertive },
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            GlyphIcon(Glyph.ALERT, Modifier.padding(top = 2.dp), tint = console.bad)
            Text(SignInWords.WORDS[problem] ?: SignInWords.WORDS.getValue("failed"), style = ConsoleType.small, color = console.ink)
        }
    }
}

@Composable
private fun PasswordStep(vm: ConsoleViewModel, form: SignInForm) {
    val colors = console
    val fresh = form.fresh
    // The password lives in this field only, until it is handed to the proof; never in saved state.
    var password by remember { mutableStateOf("") }
    val passwordFocus = remember { FocusRequester() }
    val wrong = form.problem == "wrong-password" || form.problem == "missing"
    val send = {
        val given = password
        password = ""
        vm.submitPassword(fresh, given)
    }
    val fieldColors = OutlinedTextFieldDefaults.colors(
        focusedBorderColor = colors.accent, unfocusedBorderColor = colors.lineField, focusedLabelColor = colors.accent,
        unfocusedLabelColor = colors.ink2, cursorColor = colors.accent, focusedContainerColor = colors.surface,
        unfocusedContainerColor = colors.surface, errorBorderColor = colors.bad, errorLabelColor = colors.bad,
        disabledContainerColor = colors.well, disabledTextColor = colors.ink, disabledBorderColor = colors.line, disabledLabelColor = colors.ink2,
    )
    OutlinedTextField(
        value = form.email,
        onValueChange = { vm.signInEmail(fresh, it) },
        modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.Username },
        label = { Text("E-mail address") },
        singleLine = true,
        enabled = !form.emailFixed,
        readOnly = form.busy,
        isError = wrong,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false, imeAction = ImeAction.Next),
        keyboardActions = KeyboardActions(onNext = { passwordFocus.requestFocus() }),
        shape = RoundedCornerShape(5.dp),
        colors = fieldColors,
    )
    OutlinedTextField(
        value = password,
        onValueChange = { password = it },
        modifier = Modifier.fillMaxWidth().focusRequester(passwordFocus).semantics { contentType = ContentType.Password },
        label = { Text("Password") },
        singleLine = true,
        readOnly = form.busy,
        isError = wrong,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = ImeAction.Go),
        keyboardActions = KeyboardActions(onGo = { if (!form.busy) send() }),
        shape = RoundedCornerShape(5.dp),
        colors = fieldColors,
    )
    LaunchedEffect(form.emailFixed) { if (form.emailFixed) passwordFocus.requestFocus() }
    ProblemLine(form)
    ConsoleButton(
        if (form.busy) "Checking…" else "Continue", { if (!form.busy) send() }, Modifier.fillMaxWidth(),
        kind = ButtonKind.PRIMARY, busy = form.busy,
    )
    ConsoleButton("Forgot your password?", { vm.useAwsPage(fresh) }, kind = ButtonKind.QUIET, small = true, enabled = !form.busy)
}

/**
 * The code in six boxes. One field behind them takes the digits: typed, pasted or filled in by
 * the phone from a one-time code; the boxes only show it. The sixth digit sends the code.
 */
@Composable
private fun CodeStep(vm: ConsoleViewModel, form: SignInForm) {
    val colors = console
    val fresh = form.fresh
    val wrong = form.problem == "wrong-code" || form.problem == "short-code"
    Text("Code from your authenticator app", style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
    CodeBoxes(
        code = form.code,
        onChange = { vm.codeChanged(fresh, it) },
        onDone = { vm.submitCode(fresh) },
        busy = form.busy,
        wrong = wrong,
        errorText = SignInWords.WORDS[form.problem].orEmpty(),
        tries = form.tries,
    )
    Text(
        "The six digits it shows now. The code goes in by itself once the last digit is typed.",
        Modifier.widthIn(max = 420.dp),
        style = ConsoleType.note, color = colors.ink2,
    )
    ProblemLine(form)
    ConsoleButton(
        if (form.busy) "Checking…" else "Sign in", { vm.submitCode(fresh) }, Modifier.fillMaxWidth(),
        kind = ButtonKind.PRIMARY, busy = form.busy,
    )
    ConsoleButton("Start again", { vm.startOver(fresh) }, kind = ButtonKind.QUIET, small = true, enabled = !form.busy)
}

/**
 * The code in six boxes, for the sign-in, the customer side's first code of an authenticator app,
 * and a password reset. One field behind them takes the digits: typed, pasted or filled in by the
 * phone from a one-time code; the boxes only show it. Focus comes back to it with each new answer
 * ([tries]).
 */
@Composable
fun CodeBoxes(
    code: String,
    onChange: (String) -> Unit,
    onDone: () -> Unit,
    busy: Boolean,
    wrong: Boolean,
    errorText: String,
    tries: Int,
    focusNow: Boolean = true,
) {
    val colors = console
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    var focused by remember { mutableStateOf(false) }
    LaunchedEffect(tries) {
        if (focusNow) {
            focus.requestFocus()
            keyboard?.show()
        }
    }
    BasicTextField(
        value = code,
        onValueChange = onChange,
        modifier = Modifier
            .focusRequester(focus)
            .onFocusChanged { focused = it.isFocused }
            .semantics {
                contentDescription = "Code, ${CodeEntry.LENGTH} digits"
                contentType = ContentType.SmsOtpCode
                if (wrong) error(errorText)
            },
        readOnly = busy,
        singleLine = true,
        cursorBrush = SolidColor(colors.accent),
        textStyle = TextStyle(color = colors.paper.copy(alpha = 0f)),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        decorationBox = { _ ->
            Row(Modifier.clearAndSetSemantics {}, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (index in 0 until CodeEntry.LENGTH) {
                    val digit = code.getOrNull(index)?.toString().orEmpty()
                    val current = focused && index == code.length.coerceAtMost(CodeEntry.LENGTH - 1)
                    Box(
                        Modifier
                            .padding(end = if (index == 2) 10.dp else 0.dp)
                            .size(width = 46.dp, height = 58.dp)
                            .clip(RoundedCornerShape(5.dp))
                            .background(colors.surface)
                            .border(
                                if (current) 2.dp else 1.dp,
                                when {
                                    wrong -> colors.bad
                                    current -> colors.accent
                                    else -> colors.lineField
                                },
                                RoundedCornerShape(5.dp),
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            digit,
                            style = ConsoleType.mono.copy(fontSize = 26.sp, fontWeight = FontWeight.SemiBold),
                            color = colors.ink,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
        },
    )
}
