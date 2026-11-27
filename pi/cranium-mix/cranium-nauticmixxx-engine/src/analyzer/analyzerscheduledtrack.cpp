#include "analyzer/analyzerscheduledtrack.h"

#include "analyzer/analyzertrack.h"
#include "track/track.h"
#include "track/trackid.h"

AnalyzerScheduledTrack::AnalyzerScheduledTrack(TrackId trackId, AnalyzerTrack::Options options)
        : m_trackId(trackId), m_options(options) {
}

AnalyzerScheduledTrack::AnalyzerScheduledTrack(TrackPointer track, AnalyzerTrack::Options options)
        : m_trackId(track ? track->getId() : TrackId()),
          m_track(std::move(track)),
          m_options(options) {
}

const TrackId& AnalyzerScheduledTrack::getTrackId() const {
    return m_trackId;
}

const TrackPointer& AnalyzerScheduledTrack::getTrack() const {
    return m_track;
}

const AnalyzerTrack::Options& AnalyzerScheduledTrack::getOptions() const {
    return m_options;
}
