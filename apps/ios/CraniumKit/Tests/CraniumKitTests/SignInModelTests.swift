import Foundation
import Testing
@testable import CraniumKit

/// The six boxes' rules, after the website's (signin.test.mjs, "The six boxes"), for one hidden
/// field behind them.
@Suite struct CodeEntryTests {
    @Test func aTypedDigitGoesInAndAnythingButADigitChangesNothing() {
        #expect(CodeEntry.length == 6)
        #expect(CodeEntry.digits(before: "", after: "4") == "4")
        #expect(CodeEntry.digits(before: "4", after: "42") == "42")
        #expect(CodeEntry.digits(before: "12345", after: "123456") == "123456")
        for text in ["a", " ", "-", "e", "٣", "３", "."] {
            #expect(CodeEntry.digits(before: "12", after: "12" + text) == "12", "\(text)")
        }
        // A deleted digit is gone.
        #expect(CodeEntry.digits(before: "123", after: "12") == "12")
        #expect(CodeEntry.digits(before: "1", after: "") == "")
        // Six full boxes take no seventh.
        #expect(CodeEntry.digits(before: "123456", after: "1234567") == "123456")
        #expect(CodeEntry.digits(before: "123456", after: "9123456") == "123456")
    }

    @Test func aWholeCodeFillsAllSixBoxesWhereverItArrives() {
        for text in ["123456", "123 456", " 123-456 ", "1 2 3 4 5 6", "123456\n"] {
            #expect(CodeEntry.digits(before: "", after: text) == "123456", "\(text)")
        }
        // Pasted or filled in after what was there, or before it: the code that arrived.
        #expect(CodeEntry.digits(before: "12", after: "12987654") == "987654")
        #expect(CodeEntry.digits(before: "12", after: "98765412") == "987654")
        #expect(CodeEntry.digits(before: "999", after: "999 123 456") == "123456")
        // More than six digits: the first six.
        #expect(CodeEntry.digits(before: "", after: "12345678") == "123456")
    }

    @Test func complete() {
        #expect(CodeEntry.isComplete("123456"))
        #expect(!CodeEntry.isComplete("12345"))
        #expect(!CodeEntry.isComplete("12345x"))
        #expect(!CodeEntry.isComplete("１２３４５６"))
    }

    @Test func theWordsAreTheWebsites() {
        #expect(SignInWords.awsPage == "Use the AWS sign-in page")
        #expect(SignInWords.awsPageNote == "The same account and the same code, on Amazon’s page.")
        #expect(SignInWords.codeHint == "The six digits it shows now. The code goes in by itself once the last digit is typed.")
        #expect(SignInWords.elsewhere("NEW_PASSWORD_REQUIRED") == "Your account needs a new password first, and the AWS sign-in page asks for it.")
        #expect(SignInWords.elsewhere("MFA_SETUP") == "Your account needs an authenticator app first, and the AWS sign-in page sets one up.")
        #expect(SignInWords.elsewhere("PASSWORD_RESET_REQUIRED") == "Your password has to be reset first.")
        #expect(SignInWords.elsewhere("SELECT_MFA_TYPE") == "Your account needs a step that only that page does.")
        #expect(SignInWords.codeField == "Code, 6 digits")
    }
}

/// The screen: what each answer leads to, as app.js's `afterStep` has it.
@MainActor
@Suite struct SignInModelTests {
    typealias Fixture = PasswordSignInTests

    func model(_ phone: PasswordSignInTests.Phone, email: String? = nil, fixed: Bool = false) -> SignInModel {
        SignInModel(flow: phone.signIn, email: email, fixedEmail: fixed, readingTime: 0)
    }

    func type(_ model: SignInModel, _ code: String) async {
        var text = model.digits
        for digit in code {
            text = model.editCode(text + String(digit))
        }
        await model.pendingSubmission?.value
    }

    @Test func passwordThenSixDigitsSignsInByItselfOnce() async throws {
        let phone = Fixture.phone()
        let model = model(phone)
        #expect(model.step == .password && model.focus.field == .email)
        model.email = Fixture.user.email
        await model.submitPassword(Fixture.password)
        #expect(model.step == .code)
        #expect(model.focus.field == .code)
        #expect(model.problem == nil && !model.busy)

        await type(model, "24681")
        #expect(model.ending == nil, "five digits send nothing")
        await type(model, "0")
        #expect(model.ending == .signedIn)
        #expect(Fixture.steps(phone).filter { $0 == "SOFTWARE_TOKEN_MFA" }.count == 1)
        #expect(try phone.store.load()?.accessToken == "SRP-ACCESS-1")
        // Nothing more goes once it is done.
        _ = model.editCode("123456")
        await model.submitCode()
        #expect(Fixture.steps(phone).count == 3)
    }

    @Test func aWrongCodeClearsTheBoxesAndSaysWhyACodeThatDidNotGetThroughIsKept() async throws {
        let phone = Fixture.phone()
        let model = model(phone, email: Fixture.user.email)
        #expect(model.focus.field == .password)
        await model.submitPassword(Fixture.password)
        await type(model, "000000")
        #expect(model.step == .code)
        #expect(model.digits == "")
        #expect(model.problem == .wrongCode)
        let tries = model.tries

        phone.cognito.raw = { _ in throw URLError(.timedOut) }
        await type(model, "246810")
        #expect(model.problem == .network)
        #expect(model.digits == "246810", "kept, to be sent again")
        #expect(model.tries == tries + 1)

        phone.cognito.raw = nil
        await model.submitCode()
        #expect(model.ending == .signedIn)
    }

    @Test func aShortCodeIsNotSent() async {
        let phone = Fixture.phone()
        let model = model(phone, email: Fixture.user.email)
        await model.submitPassword(Fixture.password)
        _ = model.editCode("123")
        await model.submitCode()
        #expect(model.problem == .shortCode)
        #expect(Fixture.steps(phone).count == 2)
        // And Start again goes back to the password, dropping the step of the code.
        model.startOver()
        #expect(model.step == .password && model.digits.isEmpty && model.problem == nil)
        #expect(model.focus.field == .password)
    }

    @Test func aWrongPasswordGoesBackToThePasswordAnEmptyAddressToTheAddress() async {
        let phone = Fixture.phone()
        let model = model(phone, email: Fixture.user.email)
        await model.submitPassword("Not-The-Password-1")
        #expect(model.step == .password && model.problem == .wrongPassword && model.focus.field == .password)
        model.email = "  "
        await model.submitPassword(Fixture.password)
        #expect(model.problem == .missing && model.focus.field == .email)
        // Nothing to send while not at the code.
        #expect(model.editCode("123456") == "")
    }

    @Test func aStepOnlyTheAWSPageDoesSaysWhyThenGoesThere() async throws {
        var user = Fixture.user
        user.next = "NEW_PASSWORD_REQUIRED"
        let phone = Fixture.phone(users: [user])
        let model = SignInModel(flow: phone.signIn, email: user.email, readingTime: 0.05)
        await model.submitPassword(Fixture.password)
        let why = "Your account needs a new password first, and the AWS sign-in page asks for it."
        #expect(model.step == .leaving)
        #expect(model.note == why)
        #expect(model.ending == nil, "the reason is on screen first")
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(model.ending == .awsPage(reason: why))
        // Back from the AWS page without signing in: the password step, and still why.
        model.endingSeen()
        #expect(model.step == .password && model.ending == nil && model.note == why)
        #expect(await !phone.signIn.waitsForCode)
    }

    @Test func theLinkToTheAWSPageGoesAtOnce() async {
        let phone = Fixture.phone()
        let model = model(phone, email: Fixture.user.email)
        await model.submitPassword(Fixture.password)
        model.useAwsPage()
        #expect(model.ending == .awsPage(reason: nil))
        model.endingSeen()
        #expect(model.step == .password)
        // The sign-in that waited for its code was dropped.
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(await !phone.signIn.waitsForCode)
    }

    @Test func aSignInAgainHasTheAddressFixedAndCanBeClosed() async {
        let phone = Fixture.phone()
        let model = model(phone, email: Fixture.user.email, fixed: true)
        #expect(model.emailIsFixed)
        #expect(model.focus.field == .password)
        model.cancel()
        #expect(model.ending == .cancelled)
        await model.submitPassword(Fixture.password)
        #expect(phone.cognito.calls.isEmpty, "nothing after it was closed")
        // Without a known address it is not fixed.
        #expect(!SignInModel(flow: phone.signIn, email: "  ", fixedEmail: true).emailIsFixed)
    }

    @Test func withoutTheUserPoolOnlyTheAWSPageIsLeft() async {
        let model = SignInModel(flow: nil)
        #expect(!model.hasOwnSignIn)
        await model.submitPassword("anything")
        #expect(model.step == .password && model.ending == nil)
        model.useAwsPage()
        #expect(model.ending == .awsPage(reason: nil))
    }
}

/// `userPoolId` and `region` in apps/config/cranium.json.
@Suite struct UserPoolConfigTests {
    let base: [String: String] = ["consoleUrl": "https://console.test", "loginDomain": "https://login.test",
                                  "mobileClientId": "abc123", "redirectUri": "cranium://signin"]

    @Test func theExampleNamesAUserPool() throws {
        let example = ConfigTests.configDir.appendingPathComponent("cranium.example.json")
        let loaded = try CraniumConfig.load(deployed: nil, example: example)
        let pool = try #require(loaded.config.userPool)
        #expect(pool.region == "us-east-1")
        #expect(pool.id.hasPrefix("us-east-1_"))
        #expect(pool.endpoint.absoluteString == "https://cognito-idp.us-east-1.amazonaws.com/")
    }

    @Test func bothOrNeither() throws {
        var object = base
        #expect(try CraniumConfig.parse(json(object)).userPool == nil, "an older cranium.json: the AWS page only")
        object["userPoolId"] = "eu-west-2_AbCdEf123"
        object["region"] = "eu-west-2"
        let pool = try #require(try CraniumConfig.parse(json(object)).userPool)
        #expect(pool == CognitoUserPool(id: "eu-west-2_AbCdEf123", region: "eu-west-2"))
        #expect(pool.endpoint.absoluteString == "https://cognito-idp.eu-west-2.amazonaws.com/")
        #expect(CognitoSRP.name(of: pool.id) == "AbCdEf123")
    }

    @Test(arguments: [
        (["userPoolId": "us-east-1_secretvalue"], "region"),
        (["region": "us-east-1"], "userPoolId"),
        (["userPoolId": "us-east-1_secretvalue", "region": "US-EAST-1"], "region"),
        (["userPoolId": "us-east-1_secretvalue", "region": "us-east"], "region"),
        (["userPoolId": "us-west-2_secretvalue", "region": "us-east-1"], "userPoolId"),
        (["userPoolId": "us-east-1_secret-value", "region": "us-east-1"], "userPoolId"),
        (["userPoolId": "us-east-1_", "region": "us-east-1"], "userPoolId"),
    ])
    func aBadOrHalfUserPoolIsNamedButNeverRepeated(extra: [String: String], key: String) throws {
        let object = base.merging(extra) { $1 }
        do {
            _ = try CraniumConfig.parse(json(object))
            Issue.record("\(extra) was accepted")
        } catch let error as ConfigError {
            guard case .invalid(let named, _) = error else {
                Issue.record("unexpected \(error)")
                return
            }
            #expect(named == key)
            #expect(error.errorDescription?.contains("secret") == false)
        }
    }

    @Test func regions() {
        for good in ["us-east-1", "eu-west-2", "ap-southeast-2", "us-gov-west-1", "xx-test-1", "me-central-12"] {
            #expect(CognitoUserPool.isRegion(good), "\(good)")
        }
        for bad in ["", "us", "us-1", "us-east", "useast-1", "us-east-123", "us--1", "us-East-1", "u-east-1"] {
            #expect(!CognitoUserPool.isRegion(bad), "\(bad)")
        }
    }
}
