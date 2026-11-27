// A small process that waits for NauticMixxx to finish saving and shutting down.
#include "network/updatepayload.h"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QProcess>
#include <windows.h>

int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
    int argc = __argc;
    char** argv = __argv;
    QCoreApplication app(argc, argv);
    const auto args = app.arguments();
    if (args.size() != 8) return 1;
    bool validPid = false;
    const auto pid = args[1].toULong(&validPid);
    if (!validPid || !pid || (args[7] != "restart" && args[7] != "quit")) return 2;
    const QFileInfo target(args[2]);
    if (!target.isAbsolute() || !target.isFile() || target.fileName() != "NauticMixxx.exe") return 3;
    HANDLE parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!parent) return 4;
    wchar_t image[32768];
    DWORD length = 32768;
    const bool sameProcess = QueryFullProcessImageNameW(parent, 0, image, &length) &&
            QFileInfo(QString::fromWCharArray(image, length)).canonicalFilePath().compare(
                    target.canonicalFilePath(), Qt::CaseInsensitive) == 0;
    if (!sameProcess) { CloseHandle(parent); return 5; }
    if (WaitForSingleObject(parent, INFINITE) != WAIT_OBJECT_0) { CloseHandle(parent); return 6; }
    CloseHandle(parent);

    QFile manifest(args[4] + "/UPDATE_WINDOWS.json");
    if (!manifest.open(QIODevice::ReadOnly) || manifest.size() > 16384) return 7;
    const auto payload = nautic::parseUpdateManifest(manifest.readAll(), args[5], args[6]);
    if (!payload) return 8;
    const auto installer = QDir::toNativeSeparators(args[4] + "/" + payload->filename);
    // Prevent mutation/deletion between verification and CreateProcess.
    HANDLE locked = CreateFileW(reinterpret_cast<LPCWSTR>(installer.utf16()), GENERIC_READ,
            FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (locked == INVALID_HANDLE_VALUE) return 9;
    if (!nautic::verifyUpdateFile(installer, *payload)) { CloseHandle(locked); return 10; }
    QProcess installation;
    installation.setProgram(installer);
    installation.setArguments({"/S", "/UPDATE"});
    // NSIS requires /D to be last and consumes the entire remaining native argument.
    installation.setNativeArguments("/D=" + QDir::toNativeSeparators(target.absolutePath()));
    installation.start();
    const bool success = installation.waitForStarted(30000) && installation.waitForFinished(-1) &&
            installation.exitStatus() == QProcess::NormalExit && installation.exitCode() == 0;
    CloseHandle(locked);
    QFile log(args[4] + "/install-result.txt");
    if (log.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        log.write(success ? "Update installed.\n" : "Update installer failed.\n");
    }
    if (!success) return 11;
    if (args[7] == "restart") {
        if (!QProcess::startDetached(target.absoluteFilePath(), {"--settings-path", args[3]}, target.absolutePath())) return 12;
    }
    return 0;
}
