#include "preferences/settingsmanager.h"

#include <QCoreApplication>
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QSaveFile>

#include "control/control.h"
#include "preferences/upgrade.h"
#include "util/assert.h"
#include "waveform/widgets/waveformwidgettype.h"

namespace {
#ifdef Q_OS_MACOS
// Test bundles carry an explicit portable seed and have a separate bundle ID.
// Copy inside this app's own sandbox, without asking Terminal to access another
// app's data. An existing test profile always wins over the bundled template.
void seedBundledTestProfile(const QString& settingsPath) {
    const QDir source(QCoreApplication::applicationDirPath() +
            QStringLiteral("/../Resources/nautic-test-profile"));
    const QDir target(settingsPath);
    if (!QFile::exists(source.filePath("mixxx.cfg")) ||
            QFile::exists(target.filePath("mixxx.cfg"))) return;
    const auto copySeedFile = [](const QString& from, const QString& to) {
        QFile input(from);
        QSaveFile output(to);
        if (!input.open(QIODevice::ReadOnly) || !output.open(QIODevice::WriteOnly)) {
            return false;
        }
        // Qt's APFS clonefile copy can wait on a macOS privacy check before
        // there is a window to present it. Read our bundled bytes explicitly.
        while (!input.atEnd()) {
            const auto block = input.read(64 * 1024);
            if (input.error() != QFileDevice::NoError ||
                    output.write(block) != block.size()) return false;
        }
        return output.commit();
    };
    QDirIterator files(source.path(), QDir::Files | QDir::NoSymLinks,
            QDirIterator::Subdirectories);
    while (files.hasNext()) {
        const auto file = files.next();
        const auto relative = source.relativeFilePath(file);
        if (relative == "mixxx.cfg") continue;
        const auto destination = target.filePath(relative);
        if (!QDir().mkpath(QFileInfo(destination).absolutePath()) ||
                (!QFile::exists(destination) && !copySeedFile(file, destination))) {
            qFatal("Cannot initialize NauticMixxx test profile");
        }
    }
    // Resolve portable mapping paths inside this app's sandbox and commit the
    // config last so an interrupted first run can retry the seed.
    QFile templateConfig(source.filePath("mixxx.cfg"));
    if (!templateConfig.open(QIODevice::ReadOnly)) {
        qFatal("Cannot read NauticMixxx test configuration");
    }
    auto contents = templateConfig.readAll();
    if (templateConfig.error() != QFileDevice::NoError) {
        qFatal("Cannot read NauticMixxx test configuration");
    }
    contents.replace("@NAUTIC_TEST_PROFILE@", target.absolutePath().toUtf8());
    QSaveFile config(target.filePath("mixxx.cfg"));
    if (!config.open(QIODevice::WriteOnly) ||
            config.write(contents) != contents.size() || !config.commit()) {
        qFatal("Cannot initialize NauticMixxx test configuration");
    }
}
#endif

// NauticMixxx 1.2 runs from Rekordbox USB exports. Apply the fixed operating
// policy at every start, including when an older Mixxx profile is upgraded.
void applyNauticUsbPolicy(const UserSettingsPointer& settings) {
    const auto set = [&settings](const char* group, const char* key, int value) {
        settings->setValue(ConfigKey(group, key), value);
    };
    set("[Library]", "UsbOnlyMode", 1);
    set("[Library]", "RescanOnStartup", 0);
    set("[Library]", "EnableWaveformCaching", 0);
    set("[Library]", "EnableWaveformGenerationWithAnalysis", 0);
    set("[Library]", "ShowRekordboxLibrary", 1);
    for (const char* key : {"ShowBansheeLibrary", "ShowITunesLibrary",
                 "ShowRhythmboxLibrary", "ShowSeratoLibrary", "ShowTraktorLibrary"}) {
        set("[Library]", key, 0);
    }
    set("[BPM]", "BPMDetectionEnabled", 0);
    set("[BPM]", "ReanalyzeImported", 0);
    set("[BPM]", "ReanalyzeWhenSettingsChange", 0);
    set("[Key]", "KeyDetectionEnabled", 0);
    set("[Key]", "ReanalyzeWhenSettingsChange", 0);
    set("[ReplayGain]", "ReplayGainEnabled", 0);
    set("[ReplayGain]", "ReplayGainAnalyserEnabled", 0);
    set("[ReplayGain]", "ReplayGainReanalyze", 0);
    set("[Controls]", "CueDefault", 1);
    set("[Controls]", "RateRangePercent", 6);
    set("[Controls]", "CueRecall", 2);
    set("[Controls]", "PositionDisplay", 1);
    set("[Controls]", "auto_hotcue_colors", 0);
    set("[Controls]", "auto_loop_colors", 0);
    set("[Controls]", "HotcueDefaultColorIndex", 0);
    set("[Controls]", "LoopDefaultColorIndex", 0);
    settings->setValue(ConfigKey("[Config]", "HotcueColorPalette"),
            QStringLiteral("Nautic Orange"));
    settings->setValue(ConfigKey("[ColorPalette Nautic Orange]", "0"),
            QStringLiteral("#FF8800"));
    set("[Waveform]", "OverviewNormalized", 1);
    set("[Waveform]", "UntilMarkShowBeats", 1);
    set("[Waveform]", "UntilMarkShowTime", 0);
    const ConfigKey waveformType("[Waveform]", "WaveformType");
    const int type = settings->getValue(waveformType,
            static_cast<int>(WaveformWidgetType::AllShaderRGBStackedWaveform));
    if (type != WaveformWidgetType::AllShaderSimpleWaveform &&
            type != WaveformWidgetType::AllShaderRGBWaveform &&
            type != WaveformWidgetType::AllShaderRGBStackedWaveform) {
        settings->setValue(waveformType,
                static_cast<int>(WaveformWidgetType::AllShaderRGBStackedWaveform));
    }
    if (type == WaveformWidgetType::AllShaderSimpleWaveform ||
            type == WaveformWidgetType::AllShaderRGBWaveform ||
            type == WaveformWidgetType::AllShaderRGBStackedWaveform) {
        settings->setValue(waveformType, type);
    }
    set("[Master]", "keylock_engine", 2);
}
} // namespace

SettingsManager::SettingsManager(const QString& settingsPath)
        : m_bShouldRescanLibrary(false) {
    // First make sure the settings path exists. If we don't then other parts of
    // Mixxx (such as the library) will produce confusing errors.
    if (!QDir(settingsPath).exists()) {
        QDir().mkpath(settingsPath);
    }
#ifdef Q_OS_MACOS
    seedBundledTestProfile(settingsPath);
#endif

    // Check to see if this is the first time this version of Mixxx is run
    // after an upgrade and make any needed changes.
    Upgrade upgrader;
    m_pSettings = upgrader.versionUpgrade(settingsPath);
    VERIFY_OR_DEBUG_ASSERT(!m_pSettings.isNull()) {
        m_pSettings = UserSettingsPointer(new UserSettings(""));
    }
    applyNauticUsbPolicy(m_pSettings);
    m_bShouldRescanLibrary = upgrader.rescanLibrary();

    ControlDoublePrivate::setUserConfig(m_pSettings);

#ifdef __BROADCAST__
    m_pBroadcastSettings = BroadcastSettingsPointer(
                               new BroadcastSettings(m_pSettings));
#endif
}

SettingsManager::~SettingsManager() {
    ControlDoublePrivate::setUserConfig(UserSettingsPointer());
}
