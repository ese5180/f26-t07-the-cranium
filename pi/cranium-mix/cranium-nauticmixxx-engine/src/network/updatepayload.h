#pragma once
#include <QByteArray>
#include <QString>
#include <QUrl>
#include <optional>

namespace nautic {
inline constexpr char kUpdatePublicKey[] = "qYtGKN6CDB8eym6vRj4XcUD3kLJON9zeYBtlVoEN7Dk=";
inline constexpr qint64 kMaximumUpdateBytes = 256 * 1024 * 1024;
struct UpdatePayload {
    QString version;
    QString filename;
    qint64 size;
    QByteArray sha256;
    QByteArray signature;
    QUrl url() const;
};
bool verifyUpdateSignature(const unsigned char* data, size_t size,
        const QByteArray& signature, const QByteArray& publicKey);
std::optional<UpdatePayload> parseUpdateManifest(const QByteArray& envelope,
        const QString& currentVersion, const QString& expectedVersion,
        const QByteArray& publicKey = QByteArray::fromBase64(kUpdatePublicKey));
bool verifyUpdateFile(const QString& path, const UpdatePayload& payload,
        const QByteArray& publicKey = QByteArray::fromBase64(kUpdatePublicKey));
} // namespace nautic
