#include "network/updatepayload.h"

#include <QCryptographicHash>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <openssl/evp.h>
#include <memory>

namespace nautic {
namespace {
std::optional<QList<quint32>> versionParts(const QString& version) {
    static const QRegularExpression syntax("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$");
    if (!syntax.match(version).hasMatch()) return std::nullopt;
    QList<quint32> parts;
    for (const auto& part : version.split('.')) {
        bool ok = false;
        parts.append(part.toUInt(&ok));
        if (!ok) return std::nullopt;
    }
    return parts;
}
QByteArray decode(const QJsonValue& value) {
    if (!value.isString()) return {};
    const auto text = value.toString().toLatin1();
    const auto decoded = QByteArray::fromBase64(text);
    return decoded.toBase64() == text ? decoded : QByteArray();
}
} // namespace

QUrl UpdatePayload::url() const {
    return QUrl("https://github.com/nauticsoftware/NauticMixxx/releases/download/v" + version + "/" + filename);
}

bool verifyUpdateSignature(const unsigned char* data, size_t size,
        const QByteArray& signature, const QByteArray& publicKey) {
    if (signature.size() != 64 || publicKey.size() != 32) return false;
    const std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key(
            EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, nullptr,
                    reinterpret_cast<const unsigned char*>(publicKey.constData()), publicKey.size()), EVP_PKEY_free);
    const std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> ctx(EVP_MD_CTX_new(), EVP_MD_CTX_free);
    return key && ctx && EVP_DigestVerifyInit(ctx.get(), nullptr, nullptr, nullptr, key.get()) == 1 &&
            EVP_DigestVerify(ctx.get(), reinterpret_cast<const unsigned char*>(signature.constData()),
                    signature.size(), data, size) == 1;
}

std::optional<UpdatePayload> parseUpdateManifest(const QByteArray& envelope,
        const QString& currentVersion, const QString& expectedVersion, const QByteArray& publicKey) {
    if (envelope.size() > 16384) return std::nullopt;
    const auto outer = QJsonDocument::fromJson(envelope).object();
    const auto bytes = decode(outer["payload"]);
    if (bytes.isEmpty() || !verifyUpdateSignature(reinterpret_cast<const unsigned char*>(bytes.constData()),
                bytes.size(), decode(outer["signature"]), publicKey)) return std::nullopt;
    const auto json = QJsonDocument::fromJson(bytes).object();
    const auto version = json["version"].toString();
    const auto installedParts = versionParts(currentVersion);
    const auto offeredParts = versionParts(version);
    if (!installedParts || !offeredParts || *offeredParts <= *installedParts || version != expectedVersion ||
            json["product"].toString() != "NauticMixxx" || json["platform"].toString() != "windows-x64") {
        return std::nullopt;
    }
    const auto filename = QString("NauticMixxx-%1-Windows-x64-Setup.exe").arg(version);
    const auto size = json["size"].toDouble(-1);
    if (json["filename"].toString() != filename || size < 1 || size > kMaximumUpdateBytes ||
            size != static_cast<qint64>(size)) return std::nullopt;
    const auto hash = json["sha256"].toString().toLatin1();
    static const QRegularExpression hashSyntax("^[a-f0-9]{64}$");
    const auto signature = decode(json["signature"]);
    if (!hashSyntax.match(QString::fromLatin1(hash)).hasMatch() || signature.size() != 64) return std::nullopt;
    return UpdatePayload{version, filename, static_cast<qint64>(size), hash, signature};
}

bool verifyUpdateFile(const QString& path, const UpdatePayload& payload, const QByteArray& publicKey) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly) || file.size() != payload.size ||
            payload.size < 1 || payload.size > kMaximumUpdateBytes) return false;
    auto* bytes = file.map(0, payload.size);
    if (!bytes) return false;
    // Memory mapping avoids copying a whole installer into the audio process's heap.
    const auto hash = QCryptographicHash::hash(
            QByteArray::fromRawData(reinterpret_cast<const char*>(bytes), payload.size),
            QCryptographicHash::Sha256).toHex();
    const bool valid = hash == payload.sha256 &&
            verifyUpdateSignature(bytes, payload.size, payload.signature, publicKey);
    file.unmap(bytes);
    return valid;
}
} // namespace nautic
