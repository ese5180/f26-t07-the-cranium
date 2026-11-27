#pragma once

#include "analyzer/analyzertrack.h"
#include "track/track_decl.h"
#include "track/trackid.h"

/// A track to be scheduled for analysis with additional options.
class AnalyzerScheduledTrack {
  public:
    AnalyzerScheduledTrack(TrackId trackId,
            AnalyzerTrack::Options options = AnalyzerTrack::Options());
    AnalyzerScheduledTrack(TrackPointer track,
            AnalyzerTrack::Options options = AnalyzerTrack::Options());

    /// Fetches the id of the track to be analyzed.
    const TrackId& getTrackId() const;

    /// Fetches the original track context for ad-hoc analysis, if supplied.
    const TrackPointer& getTrack() const;

    /// Fetches the additional options.
    const AnalyzerTrack::Options& getOptions() const;

  private:
    /// The id of the track to be analyzed.
    TrackId m_trackId;
    TrackPointer m_track;
    /// The additional options.
    AnalyzerTrack::Options m_options;
};

Q_DECLARE_TYPEINFO(AnalyzerScheduledTrack, Q_MOVABLE_TYPE);
