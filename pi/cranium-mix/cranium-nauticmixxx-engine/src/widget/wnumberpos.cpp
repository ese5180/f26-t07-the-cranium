#include "util/fpclassify.h"
#include "widget/wnumberpos.h"

#include <QMouseEvent>

#include "control/controlproxy.h"
#include "control/controlobject.h"
#include "moc_wnumberpos.cpp"
#include "util/duration.h"
#include <QFontInfo>
#include "mixer/playerinfo.h"
#include "track/track.h"
#include "track/beats.h"
#include "track/cue.h"
#include "widget/rx3displayformat.h"

WNumberPos::WNumberPos(const QString& group, QWidget* parent)
        : WNumber(parent),
          m_group(group),
          m_displayFormat(TrackTime::DisplayFormat::TRADITIONAL),
          m_dOldTimeElapsed(0.0) {
    m_pTimeElapsed = new ControlProxy(group, "time_elapsed", this, ControlFlag::NoAssertIfMissing);
    m_pTimeElapsed->connectValueChanged(this, &WNumberPos::slotSetTimeElapsed);
    m_pTimeRemaining = new ControlProxy(
            group, "time_remaining", this, ControlFlag::NoAssertIfMissing);
    m_pTimeRemaining->connectValueChanged(
            this, &WNumberPos::slotTimeRemainingUpdated);

    m_pShowTrackTimeRemaining = new ControlProxy(
            "[Controls]", "ShowDurationRemaining", this);
    m_pShowTrackTimeRemaining->connectValueChanged(
            this, &WNumberPos::slotSetDisplayMode);
    slotSetDisplayMode(m_pShowTrackTimeRemaining->get());

    m_pTimeFormat = new ControlProxy(
            "[Controls]", "TimeFormat", this);
    m_pTimeFormat->connectValueChanged(
            this, &WNumberPos::slotSetTimeFormat);
    slotSetTimeFormat(m_pTimeFormat->get());
}

void WNumberPos::setup(const QDomNode& node, const SkinContext& context) {
    WNumber::setup(node, context);
    if(m_rx3Format=="deck" || m_rx3Format=="browse") {
        m_rx3TimeMode=new ControlProxy(m_group,"rx3_time_remaining",this,ControlFlag::NoAssertIfMissing);
        if(m_rx3TimeMode->valid()) {
            m_rx3TimeMode->connectValueChanged(this,&WNumberPos::slotSetDisplayMode);
            slotSetDisplayMode(m_rx3TimeMode->get());
        }
        m_rx3Hold.setSingleShot(true);m_rx3Hold.setInterval(1000);
        connect(&m_rx3Hold,&QTimer::timeout,this,[this] {
            if(!m_rx3Pressed) return;
            m_rx3Held=true;
            const ConfigKey key(m_group,"rx3_auto_cue");
            if(ControlObject::exists(key)) ControlObject::set(key,ControlObject::get(key)>0?0:1);
        });
    }
    if ((m_rx3Format == QStringLiteral("bars") || m_rx3Format == QStringLiteral("countdown"))) {
        const auto observeTrack = [this](const TrackPointer& track) {
            disconnect(m_rx3BeatsConnection);
            disconnect(m_rx3CuesConnection);
            if (track) {
                m_rx3CuesConnection = connect(track.get(), &Track::cuesUpdated, this,
                        [this] { slotSetTimeElapsed(m_pTimeElapsed->get()); });
                m_rx3BeatsConnection = connect(track.get(), &Track::beatsUpdated, this,
                        [this] { slotSetTimeElapsed(m_pTimeElapsed->get()); });
            }
            slotSetTimeElapsed(m_pTimeElapsed->get());
        };
        connect(&PlayerInfo::instance(), &PlayerInfo::trackChanged, this,
                [this, observeTrack](const QString& group, TrackPointer track, TrackPointer) {
                    if (group == m_group) observeTrack(track);
                });
        observeTrack(PlayerInfo::instance().getTrackInfo(m_group));
    }
    slotSetTimeElapsed(m_pTimeElapsed->get());
}

void WNumberPos::mousePressEvent(QMouseEvent* pEvent) {
    if ((m_rx3Format == QStringLiteral("bars") || m_rx3Format == QStringLiteral("countdown")) || m_rx3Format == QStringLiteral("transport")) return;
    if((m_rx3Format=="deck" || m_rx3Format=="browse") && pEvent->button()==Qt::LeftButton) {
        m_rx3Pressed=true;m_rx3Held=false;m_rx3Hold.start();pEvent->accept();return;
    }
    bool leftClick = pEvent->buttons() & Qt::LeftButton;

    if (leftClick) {
        // Cycle through display modes
        if (m_displayMode == TrackTime::DisplayMode::ELAPSED) {
            m_displayMode = TrackTime::DisplayMode::REMAINING;
        } else if (m_displayMode == TrackTime::DisplayMode::REMAINING) {
            m_displayMode = TrackTime::DisplayMode::ELAPSED_AND_REMAINING;
        } else if (m_displayMode == TrackTime::DisplayMode::ELAPSED_AND_REMAINING) {
            m_displayMode = TrackTime::DisplayMode::ELAPSED;
        }

        m_pShowTrackTimeRemaining->set(static_cast<double>(m_displayMode));
        slotSetTimeElapsed(m_dOldTimeElapsed);
    }
}

void WNumberPos::mouseReleaseEvent(QMouseEvent* event) {
    if(m_rx3Pressed && event->button()==Qt::LeftButton) {
        m_rx3Hold.stop();m_rx3Pressed=false;
        if(!m_rx3Held && rect().contains(event->pos())) {
            auto* control=m_rx3TimeMode && m_rx3TimeMode->valid()?m_rx3TimeMode:m_pShowTrackTimeRemaining;
            const double mode=m_displayMode==TrackTime::DisplayMode::ELAPSED?1:0;
            control->set(mode);
            slotSetDisplayMode(mode);
        }
        event->accept();return;
    }
    WNumber::mouseReleaseEvent(event);
}

// Reimplementing WNumber::setValue
void WNumberPos::setValue(double dValue) {
    // Ignore midi-scaled signals from the skin connection.
    Q_UNUSED(dValue);
    // Update our value with the old value.
    slotSetTimeElapsed(m_dOldTimeElapsed);
}

void WNumberPos::slotSetTimeElapsed(double dTimeElapsed) {
    double dTimeRemaining = m_pTimeRemaining->get();
    if ((m_rx3Format == QStringLiteral("bars") || m_rx3Format == QStringLiteral("countdown"))) {
        QString count = QStringLiteral("—");
        const auto track = PlayerInfo::instance().getTrackInfo(m_group);
        const auto beats = track ? track->getBeats() : nullptr;
        if (beats && beats->firstBeat().isValid() && util_isfinite(dTimeElapsed)) {
            const auto position = mixxx::audio::FramePos(dTimeElapsed * beats->getSampleRate());
            auto beat = beats->iteratorFrom(position);
            if (*beat > position) --beat;
            if (m_rx3Format == QStringLiteral("countdown")) {
                mixxx::audio::FramePos next;
                for (const auto& cue : track->getCuePoints()) {
                    const auto type = cue->getType();
                    if (type != mixxx::CueType::HotCue && type != mixxx::CueType::MainCue &&
                            type != mixxx::CueType::Loop) continue;
                    const auto candidate = cue->getPosition();
                    if (candidate.isValid() && candidate > position && (!next.isValid() || candidate < next)) next = candidate;
                }
                if (next.isValid()) {
                    auto target = beats->iteratorFrom(next);
                    if (*target > next && next - *(target - 1) < *target - next) --target;
                    count = QString::number(std::max(0, int(target - beat)));
                }
            } else {
                count = rx3::bars(beat - beats->cfirstmarker());
            }
        }
        setText(rx3::smallSuffix(count, (m_rx3Format == QStringLiteral("countdown") ? tr(" Beats") : QStringLiteral(" Bars")), QFontInfo(font()).pixelSize()));
        m_dOldTimeElapsed = dTimeElapsed;
        return;
    }
    if (m_rx3Format == QStringLiteral("deck") || m_rx3Format == QStringLiteral("transport") || m_rx3Format == QStringLiteral("browse")) {
        const bool transport = m_rx3Format == QStringLiteral("transport");
        if (m_rx3Format == QStringLiteral("browse")) {
            setText(rx3::time(std::abs(m_displayMode==TrackTime::DisplayMode::ELAPSED?dTimeElapsed:dTimeRemaining)).section('.',0,0));
            return;
        }
        double seconds = transport || m_displayMode != TrackTime::DisplayMode::ELAPSED
                ? dTimeRemaining : dTimeElapsed;
        const bool negative = !transport && m_displayMode == TrackTime::DisplayMode::ELAPSED && seconds < 0;
        const QString value = rx3::time(std::abs(seconds), transport);
        if (transport) setText(value);
        else {
            const int dot = value.indexOf('.');
            setText(rx3::smallSuffix((negative ? QStringLiteral("−") : QString()) + value.left(dot),
                    value.mid(dot), QFontInfo(font()).pixelSize()));
        }
        m_dOldTimeElapsed = dTimeElapsed;
        return;
    }
    QString (*timeFormat)(double dSeconds, mixxx::Duration::Precision precision);

    if (m_displayFormat == TrackTime::DisplayFormat::KILO_SECONDS) {
        timeFormat = &mixxx::Duration::formatKiloSeconds;
    } else if (m_displayFormat == TrackTime::DisplayFormat::SECONDS_LONG) {
        timeFormat = &mixxx::Duration::formatSecondsLong;
    } else if (m_displayFormat == TrackTime::DisplayFormat::SECONDS) {
       timeFormat = &mixxx::Duration::formatSeconds;
    } else {
        timeFormat = &mixxx::Duration::formatTime;
    }

    mixxx::Duration::Precision precision;
    if (m_displayFormat != TrackTime::DisplayFormat::TRADITIONAL_COARSE) {
        precision = mixxx::Duration::Precision::CENTISECONDS;
    } else {
        precision = mixxx::Duration::Precision::SECONDS;
    }

    if (m_displayMode == TrackTime::DisplayMode::ELAPSED) {
        if (dTimeElapsed >= 0.0) {
            setText(timeFormat(dTimeElapsed, precision));
        } else {
            setText(QLatin1String("-") % timeFormat(-dTimeElapsed, precision));
        }
    } else if (m_displayMode == TrackTime::DisplayMode::REMAINING) {
        setText(QLatin1String("-") % timeFormat(dTimeRemaining, precision));
    } else if (m_displayMode == TrackTime::DisplayMode::ELAPSED_AND_REMAINING) {
        if (dTimeElapsed >= 0.0) {
            setText(timeFormat(dTimeElapsed, precision)
                    % QLatin1String("  -") % timeFormat(dTimeRemaining, precision));
        } else {
            setText(QLatin1String("-") % timeFormat(-dTimeElapsed, precision)
                    % QLatin1String("  -") % timeFormat(dTimeRemaining, precision));
        }
    }
    m_dOldTimeElapsed = dTimeElapsed;
}

// m_pTimeElapsed is not updated when paused at the beginning of a track,
// but m_pTimeRemaining is updated in that case. So, call slotSetTimeElapsed to
// update this widget's text.
void WNumberPos::slotTimeRemainingUpdated(double dTimeRemaining) {
    Q_UNUSED(dTimeRemaining);
    double dTimeElapsed = m_pTimeElapsed->get();
    if (dTimeElapsed == 0.0) {
        slotSetTimeElapsed(dTimeElapsed);
    }
}

void WNumberPos::slotSetDisplayMode(double remain) {
    if(m_rx3TimeMode && m_rx3TimeMode->valid()) remain=m_rx3TimeMode->get();
    if (remain == 1.0) {
        m_displayMode = TrackTime::DisplayMode::REMAINING;
    } else if (remain == 2.0) {
        m_displayMode = TrackTime::DisplayMode::ELAPSED_AND_REMAINING;
    } else {
        m_displayMode = TrackTime::DisplayMode::ELAPSED;
    }

    slotSetTimeElapsed(m_dOldTimeElapsed);
}
void WNumberPos::slotSetTimeFormat(double v) {
    m_displayFormat = static_cast<TrackTime::DisplayFormat>(static_cast<int>(v));

    slotSetTimeElapsed(m_dOldTimeElapsed);
}
