#include <gtest/gtest.h>
#include <QCryptographicHash>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTemporaryDir>
#include <openssl/evp.h>

#include "network/integratedupdater.h"
#include "network/updatepayload.h"

namespace {
class FakeUpdater : public nautic::IntegratedUpdater {
  public:
    bool playing = false;
    int downloads = 0;
    int installations = 0;
    int armed = 0;
    FakeUpdater() : IntegratedUpdater("1.9.0", [this] { return playing; }, [] {}) {}
    void startDownload() override { ++downloads; }
    void installAndRelaunch() override { ++installations; }
    bool armInstallOnQuit() override { ++armed; return true; }
};
struct SignedFixture {
    // Deterministic test-only key, unrelated to the release key in macOS Keychain.
    EVP_PKEY* key = nullptr;
    QByteArray publicKey = QByteArray(32, '\0');
    QByteArray artifact = "test installer content";
    QJsonObject metadata;
    SignedFixture() {
        const QByteArray seed(32, 'T');
        key = EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, nullptr,
                reinterpret_cast<const unsigned char*>(seed.constData()), seed.size());
        size_t size = publicKey.size();
        EVP_PKEY_get_raw_public_key(key, reinterpret_cast<unsigned char*>(publicKey.data()), &size);
        metadata = {{"product", "NauticMixxx"}, {"platform", "windows-x64"},
                {"version", "1.9.1"}, {"filename", "NauticMixxx-1.9.1-Windows-x64-Setup.exe"},
                {"size", artifact.size()},
                {"sha256", QString::fromLatin1(QCryptographicHash::hash(artifact, QCryptographicHash::Sha256).toHex())},
                {"signature", QString::fromLatin1(sign(artifact).toBase64())}};
    }
    ~SignedFixture() { EVP_PKEY_free(key); }
    QByteArray sign(const QByteArray& bytes) const {
        QByteArray signature(64, '\0');
        size_t length = signature.size();
        auto* ctx = EVP_MD_CTX_new();
        EVP_DigestSignInit(ctx, nullptr, nullptr, nullptr, key);
        EVP_DigestSign(ctx, reinterpret_cast<unsigned char*>(signature.data()), &length,
                reinterpret_cast<const unsigned char*>(bytes.constData()), bytes.size());
        EVP_MD_CTX_free(ctx);
        return signature;
    }
    QByteArray envelope() const {
        const auto payload = QJsonDocument(metadata).toJson(QJsonDocument::Compact);
        return QJsonDocument(QJsonObject{{"payload", QString::fromLatin1(payload.toBase64())},
                {"signature", QString::fromLatin1(sign(payload).toBase64())}}).toJson();
    }
    std::optional<nautic::UpdatePayload> parse() const {
        return nautic::parseUpdateManifest(envelope(), "1.9.0", "1.9.1", publicKey);
    }
};
} // namespace

TEST(IntegratedUpdaterTest, RejectsDowngradesInvalidVersionsAndDuplicateStarts) {
    FakeUpdater updater;
    for (const auto& version : {"1.8.0", "1.9.0", "1.9.1-beta", "01.9.1", "1.9.1/evil"}) {
        updater.begin(version, FakeUpdater::Mode::InstallNow);
        EXPECT_EQ(0, updater.downloads);
    }
    updater.begin("1.9.1", FakeUpdater::Mode::InstallNow);
    updater.begin("1.10.0", FakeUpdater::Mode::InstallNow);
    EXPECT_EQ(1, updater.downloads);
}
TEST(IntegratedUpdaterTest, PlaybackStartingDuringDownloadDefersInstall) {
    FakeUpdater updater;
    updater.begin("1.9.1", FakeUpdater::Mode::InstallNow);
    updater.playing = true;
    updater.ready();
    EXPECT_EQ(0, updater.installations);
    updater.installNow();
    EXPECT_EQ(0, updater.installations);
    updater.playing = false;
    // Stopping playback alone never unexpectedly closes the application.
    EXPECT_EQ(0, updater.installations);
    updater.installNow();
    EXPECT_EQ(1, updater.installations);
}
TEST(IntegratedUpdaterTest, BackgroundChoiceNeverClosesTheApplication) {
    FakeUpdater updater;
    updater.begin("1.9.1", FakeUpdater::Mode::InstallOnQuit);
    updater.ready();
    EXPECT_EQ(0, updater.installations);
    EXPECT_TRUE(updater.prepareQuit());
    EXPECT_EQ(1, updater.armed);
}
TEST(IntegratedUpdaterTest, IncompleteDownloadsDoNotArmAnInstallerOnQuit) {
    FakeUpdater updater;
    updater.begin("1.9.1", FakeUpdater::Mode::InstallNow);
    updater.installNow();
    EXPECT_TRUE(updater.prepareQuit());
    EXPECT_EQ(0, updater.armed);
    EXPECT_EQ(0, updater.installations);
}
TEST(UpdatePayloadTest, AcceptsSignedManifestAndPinsItsArtifactUrl) {
    SignedFixture fixture;
    const auto parsed = fixture.parse();
    ASSERT_TRUE(parsed);
    EXPECT_EQ(QUrl("https://github.com/nauticsoftware/NauticMixxx/releases/download/v1.9.1/NauticMixxx-1.9.1-Windows-x64-Setup.exe"), parsed->url());
    EXPECT_FALSE(nautic::parseUpdateManifest(fixture.envelope(), "1.9.0", "1.10.0", fixture.publicKey));
    EXPECT_FALSE(nautic::parseUpdateManifest(fixture.envelope(), "1.9.1", "1.9.1", fixture.publicKey));
    EXPECT_FALSE(nautic::parseUpdateManifest(fixture.envelope(), "1.10.0", "1.9.1", fixture.publicKey));
}
TEST(UpdatePayloadTest, RejectsAnotherSigningKeyAndUnsignedMetadata) {
    SignedFixture fixture;
    EXPECT_FALSE(nautic::parseUpdateManifest(fixture.envelope(), "1.9.0", "1.9.1"));
    auto envelope = QJsonDocument::fromJson(fixture.envelope()).object();
    envelope["payload"] = QString::fromLatin1(QByteArray("{}").toBase64());
    EXPECT_FALSE(nautic::parseUpdateManifest(QJsonDocument(envelope).toJson(), "1.9.0", "1.9.1", fixture.publicKey));
    envelope["signature"] = "invalid";
    EXPECT_FALSE(nautic::parseUpdateManifest(QJsonDocument(envelope).toJson(), "1.9.0", "1.9.1", fixture.publicKey));
}
TEST(UpdatePayloadTest, RejectsPathsWrongProductsAndMalformedVersionsEvenIfSigned) {
    for (const auto& pair : {qMakePair("filename", "../evil.exe"), qMakePair("product", "Other"),
                 qMakePair("platform", "macos-arm64"), qMakePair("version", "01.9.1"),
                 qMakePair("sha256", "1234"), qMakePair("signature", "bad")}) {
        SignedFixture fixture;
        fixture.metadata[pair.first] = pair.second;
        EXPECT_FALSE(fixture.parse());
    }
}
TEST(UpdatePayloadTest, RejectsEmptyOversizedFractionalAndNonNumericSizes) {
    for (const auto size : {-1.0, 0.0, 1.5, double(nautic::kMaximumUpdateBytes + 1)}) {
        SignedFixture fixture;
        fixture.metadata["size"] = size;
        EXPECT_FALSE(fixture.parse());
    }
    SignedFixture fixture;
    fixture.metadata["size"] = "1024";
    EXPECT_FALSE(fixture.parse());
    EXPECT_FALSE(nautic::parseUpdateManifest(QByteArray(16385, 'x'), "1.9.0", "1.9.1", fixture.publicKey));
}
TEST(UpdatePayloadTest, VerifiesCompleteArtifactAndRejectsTamperingAndTruncation) {
    SignedFixture fixture;
    const auto payload = fixture.parse();
    ASSERT_TRUE(payload);
    QTemporaryDir temporary;
    ASSERT_TRUE(temporary.isValid());
    const auto path = temporary.filePath("installer.exe");
    auto write = [&path](const QByteArray& bytes) {
        QFile file(path);
        EXPECT_TRUE(file.open(QIODevice::WriteOnly));
        EXPECT_EQ(bytes.size(), file.write(bytes));
    };
    write(fixture.artifact);
    EXPECT_TRUE(nautic::verifyUpdateFile(path, *payload, fixture.publicKey));
    EXPECT_FALSE(nautic::verifyUpdateFile(path, *payload));
    write(QByteArray(fixture.artifact.size(), 'x'));
    EXPECT_FALSE(nautic::verifyUpdateFile(path, *payload, fixture.publicKey));
    write(fixture.artifact.left(3));
    EXPECT_FALSE(nautic::verifyUpdateFile(path, *payload, fixture.publicKey));
    write(fixture.artifact + "extra");
    EXPECT_FALSE(nautic::verifyUpdateFile(path, *payload, fixture.publicKey));
}
