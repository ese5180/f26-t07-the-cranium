#pragma once

#include <algorithm>
#include <cmath>

#include "library/rekordbox/rekordboxruntimecatalog.h"
#include "track/keyutils.h"

namespace rx3 {
struct BrowserRows {
    int rowHeight;
    int headerHeight;
};
inline BrowserRows twelveBrowserRows(int availableHeight) {
    const int available=qMax(13,availableHeight);
    const int row=available/13;
    return {row,available-12*row};
}
inline int categoryRank(const QString& label) {
    const QStringList order={"ARTIST","ALBUM","TRACK","KEY","PLAYLIST","HISTORY","MATCHING","FOLDER","REC"};
    QString normalized=label.toUpper();
    if(normalized=="ALBUMS") normalized="ALBUM";
    if(normalized=="TRACKS") normalized="TRACK";
    const int rank=order.indexOf(normalized);
    return rank<0 ? order.size() : rank;
}
// NauticMixxx matching rule, not an emulation of Rekordbox's saved pairs:
// compatible circle-of-fifths keys and tempo within six percent. Both metadata
// values must exist. The reference track itself is always excluded.
inline QList<quint32> matchingTrackIds(
        const QHash<quint32,mixxx::rekordbox::RuntimeTrack>& tracks,
        const QString& referencePath, const QString& key, double bpm) {
    QList<quint32> result;
    const auto referenceKey=KeyUtils::guessKeyFromText(key);
    if(referenceKey==mixxx::track::io::key::INVALID || !std::isfinite(bpm) || bpm<=0) return result;
    const auto compatible=KeyUtils::getCompatibleKeys(referenceKey);
    for(auto it=tracks.cbegin();it!=tracks.cend();++it) {
        if(it->resolvedAudioPath==referencePath || !it->bpm || !std::isfinite(*it->bpm) || *it->bpm<=0) continue;
        if(std::abs(*it->bpm-bpm)/bpm>0.06 ||
                !compatible.contains(KeyUtils::guessKeyFromText(it->key))) continue;
        result.append(it.key());
    }
    std::sort(result.begin(),result.end(),[&](quint32 a,quint32 b){
        const double da=std::abs(*tracks.value(a).bpm-bpm),db=std::abs(*tracks.value(b).bpm-bpm);
        return da==db ? a<b : da<db;
    });
    return result;
}
} // namespace rx3
