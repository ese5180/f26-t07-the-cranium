#pragma once

#include <QElapsedTimer>
#include <QHash>
#include <QSet>
#include <QTimer>
#include <QUrl>
#include <cmath>

#include "control/controlobject.h"
#include "mixer/playerinfo.h"
#include "track/track.h"

namespace rx3 {

// Listening-time ledger. The library owns any explicit USB history writer;
// this class does not count seeks, previews or immediate dominant-deck marks.
class BrowserPlaybackLedger {
  public:
    struct Sample {
        QString group;
        QString identity;
        bool playing;
    };
    static constexpr double kPlayedSeconds = 60.0;

    void advance(const QList<Sample>& samples, double elapsedSeconds) {
        m_playing.clear();
        QSet<QString> present;
        for (const auto& sample : samples) {
            present.insert(sample.group);
            auto& deck = m_decks[sample.group];
            if (deck.identity != sample.identity) {
                deck = {sample.identity, 0, false};
            }
            // Use elapsed listening time, never the seek position or duration.
            // Both ends of an interval must be playing the same loaded track.
            if (sample.playing && deck.playing && std::isfinite(elapsedSeconds) &&
                    elapsedSeconds > 0 && elapsedSeconds <= 1) {
                deck.seconds += elapsedSeconds;
            }
            deck.playing = sample.playing;
            if (sample.identity.isEmpty()) continue;
            if (sample.playing) m_playing.insert(sample.identity);
            if (deck.seconds >= kPlayedSeconds) m_played.insert(sample.identity);
        }
        for (auto it = m_decks.begin(); it != m_decks.end();) {
            if (!present.contains(it.key())) it = m_decks.erase(it);
            else ++it;
        }
    }
    bool isPlaying(const QString& identity) const { return m_playing.contains(identity); }
    bool wasPlayed(const QString& identity) const { return m_played.contains(identity); }

  private:
    struct Deck { QString identity; double seconds; bool playing; };
    QHash<QString, Deck> m_decks;
    QSet<QString> m_playing;
    QSet<QString> m_played;
};

class BrowserPlaybackState : public QObject {
  public:
    explicit BrowserPlaybackState(QObject* parent) : QObject(parent) {
        m_elapsed.start();
        connect(&m_timer, &QTimer::timeout, this, [this] { refresh(); });
        connect(&PlayerInfo::instance(), &PlayerInfo::trackChanged,
                this, [this] { refresh(); });
        m_timer.start(100);
    }
    static QString identity(const TrackPointer& track) {
        if (!track) return {};
        const auto& binding = track->getSourceBinding();
        if (binding.sourceType() == mixxx::SourceType::RekordboxUsb) {
            QUrl url;
            url.setScheme(QStringLiteral("rekordbox-usb"));
            url.setHost(binding.sessionIdentifier().uuid().toString(QUuid::WithoutBraces));
            url.setPath(QStringLiteral("/track/%1").arg(binding.rekordboxId()));
            return url.toString();
        }
        return QUrl::fromLocalFile(track->getLocation()).toString();
    }
    bool isPlaying(const QUrl& url) const { return m_ledger.isPlaying(url.toString()); }
    bool wasPlayed(const QUrl& url) const { return m_ledger.wasPlayed(url.toString()); }
    const QList<TrackPointer>& playedTracks() const {return m_playedTracks;}

  private:
    void refresh() {
        QList<BrowserPlaybackLedger::Sample> samples;
        const auto loaded = PlayerInfo::instance().getLoadedTracks();
        for (auto it = loaded.cbegin(); it != loaded.cend(); ++it) {
            // Preview players and samplers never mark browser tracks as played.
            if (!it.key().startsWith(QStringLiteral("[Channel"))) continue;
            const bool available = it.value() && it.value()->isSourceAvailableForPlayback();
            samples.append({it.key(), identity(it.value()), available &&
                    ControlObject::get(ConfigKey(it.key(), QStringLiteral("play"))) > 0 &&
                    ControlObject::get(ConfigKey(it.key(), QStringLiteral("cue_preview"))) == 0});
        }
        m_ledger.advance(samples, m_elapsed.restart() / 1000.0);
        for(auto it=loaded.cbegin();it!=loaded.cend();++it) {
            if(!it.key().startsWith("[Channel") || !it.value()) continue;
            const auto key=identity(it.value());
            if(m_ledger.wasPlayed(key) && !m_recordedIdentities.contains(key)) {
                m_recordedIdentities.insert(key);m_playedTracks.append(it.value());
            }
        }
    }
    QTimer m_timer;
    QElapsedTimer m_elapsed;
    BrowserPlaybackLedger m_ledger;
    QList<TrackPointer> m_playedTracks;
    QSet<QString> m_recordedIdentities;
};

} // namespace rx3
