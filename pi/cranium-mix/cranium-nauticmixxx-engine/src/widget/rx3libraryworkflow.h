#pragma once

#include <QList>
#include <QSet>
#include <array>
#include <algorithm>
#include <cmath>
#include "library/rekordbox/rekordboxruntimecatalog.h"
#include "track/keyutils.h"

namespace rx3 {
struct TrackFilter {
    double referenceBpm = 0;
    double tempoTolerance = 0; // Zero disables the tempo condition.
    QString referenceKey;
    int keyMode = 0; // Off, compatible, exact.
    int minimumRating = 0;
    int color = 0; // Zero means any color.
    bool accepts(const mixxx::rekordbox::RuntimeTrack& track) const {
        if (tempoTolerance > 0 && (!std::isfinite(referenceBpm) || referenceBpm <= 0 ||
                    !track.bpm || !std::isfinite(*track.bpm) ||
                    std::abs(*track.bpm-referenceBpm) > referenceBpm*tempoTolerance)) return false;
        if (track.rating.value_or(0) < quint32(minimumRating) ||
                (color > 0 && track.colorId.value_or(0) != quint32(color))) return false;
        if (keyMode) {
            const auto reference = KeyUtils::guessKeyFromText(referenceKey);
            const auto candidate = KeyUtils::guessKeyFromText(track.key);
            if (reference == mixxx::track::io::key::INVALID ||
                    candidate == mixxx::track::io::key::INVALID) return false;
            if (keyMode == 2 ? candidate != reference :
                    !KeyUtils::getCompatibleKeys(reference).contains(candidate)) return false;
        }
        return true;
    }
    QList<quint32> apply(const QHash<quint32,mixxx::rekordbox::RuntimeTrack>& tracks) const {
        QList<quint32> ids;
        for (auto it=tracks.cbegin(); it!=tracks.cend(); ++it) if (accepts(it.value())) ids.append(it.key());
        std::sort(ids.begin(),ids.end());return ids;
    }
};

// USB/session identities own temporary lists. A reconnect must not silently
// attach tags to different exported tracks which happen to reuse the same IDs.
class TagList {
  public:
    static constexpr int kMaximumTracks = 100;
    bool toggle(quint32 id) {
        if (!id) return false;
        if (m_ids.removeAll(id)) return true;
        if (m_ids.size() >= kMaximumTracks) return false;
        m_ids.append(id);return true;
    }
    const QList<quint32>& ids() const {return m_ids;}
    void clear() {m_ids.clear();}
  private:
    QList<quint32> m_ids;
};
} // namespace rx3
