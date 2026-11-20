#pragma once

#include <QApplication>
#include <QEvent>
#include <QRegularExpression>
#include <QWidget>
#include <array>
#include <memory>
#include <vector>

#include "control/controlobject.h"
#include "control/controlproxy.h"
#include "mixer/playerinfo.h"
#include "track/beats.h"
#include "track/track.h"

// Selection is explicit: track title, waveform deck card, or PERFORMANCE LOAD.
// Deck controls and engine feedback never change selection.
class Rx3PerformanceState : public QObject {
  public:
    explicit Rx3PerformanceState(QObject* parent=nullptr) : QObject(parent) {
        ensure("[RX3Controller]","active_deck",1);
        ensure("[RX3Controller]","grid_mode",0);
        for(int deck=1;deck<=2;++deck) {
            ensure("[RX3Display]",QString("active%1").arg(deck),deck==1);
            ensure("[RX3Display]",QString("gridpanel%1").arg(deck),0);
            ensure("[RX3Display]",QString("gridshift%1").arg(deck),1);
        }
        for(const auto& action : {"grid_snap_cue","grid_shift","grid_earlier_half","grid_later_half","grid_reset"}) {
            ensure("[RX3Controller]",action,0);
            auto* input=new ControlProxy("[RX3Controller]",action,this);
            input->connectValueChanged(this,[this,action](double value){if(value>0) applyAction(action);});
        }
        auto* active=new ControlProxy("[RX3Controller]","active_deck",this);
        active->connectValueChanged(this,[this](double value){selectDeck(qRound(value));});
        auto* grid=new ControlProxy("[RX3Controller]","grid_mode",this);
        grid->connectValueChanged(this,[this](double value){
            const bool entering=value>0 && !m_grid;
            m_grid=value>0;
            if(entering) {
                m_originalTrack={};m_originalBeats={};captureGrid();
                ControlObject::set(ConfigKey("[RX3SidePanel]","current"),0);
            }
            refresh();
        });
        qApp->installEventFilter(this);
        selectDeck(qRound(active->get()));
    }
    int activeDeck() const {return m_active;}
    void selectDeck(int deck) {
        if(deck<1 || deck>2) return;
        m_active=deck;
        if(ControlObject::get(ConfigKey("[RX3Controller]","active_deck"))!=deck)
            ControlObject::set(ConfigKey("[RX3Controller]","active_deck"),deck);
        if(m_grid) captureGrid();
        refresh();
    }
  protected:
    bool eventFilter(QObject* object,QEvent* event) override {
        if(event->type()==QEvent::MouseButtonPress || event->type()==QEvent::TouchBegin) {
            for(auto* widget=qobject_cast<QWidget*>(object);widget;widget=widget->parentWidget()) {
                const int deck=widget->property("rx3DeckSelect").toInt();
                if(deck>0) {selectDeck(deck);break;}
            }
        }
        return false;
    }
  private:
    void ensure(const QString& group,const QString& item,double initial) {
        if(!ControlObject::exists(ConfigKey(group,item))) m_owners.push_back(
                std::make_unique<ControlObject>(ConfigKey(group,item),false,false,false,initial));
    }
    QString group() const {return QString("[Channel%1]").arg(m_active);}
    void refresh() {
        for(int deck=1;deck<=2;++deck) {
            ControlObject::set(ConfigKey("[RX3Display]",QString("active%1").arg(deck)),deck==m_active);
            ControlObject::set(ConfigKey("[RX3Display]",QString("gridpanel%1").arg(deck)),m_grid && deck==m_active);
        }
    }
    void captureGrid() {
        const auto track=PlayerInfo::instance().getTrackInfo(group());
        const auto index=m_active-1;
        if(track!=m_originalTrack[index]) {
            m_originalTrack[index]=track;
            m_originalBeats[index]=track?track->getBeats():mixxx::BeatsPointer();
        }
    }
    void applyAction(const QString& action) {
        if(!m_grid) return;
        captureGrid();
        const auto track=m_originalTrack[m_active-1];
        if(!track || !track->getBeats()) return;
        const auto beats=track->getBeats();
        if(action=="grid_reset") {
            if(m_originalBeats[m_active-1]) track->trySetBeats(m_originalBeats[m_active-1]);
            return;
        }
        if(action=="grid_shift") return; // Encoder continuously translates the selected grid.
        mixxx::audio::FrameDiff_t offset=0;
        if(action=="grid_snap_cue") {
            const auto cue=track->getMainCuePosition();
            if(!cue.isValid()) return;
            const auto closest=beats->findClosestBeat(cue);
            if(!closest.isValid()) return;
            offset=cue-closest;
        } else {
            const auto position=mixxx::audio::FramePos(
                    ControlObject::get(ConfigKey(group(),"playposition"))*track->getDuration()*track->getSampleRate().value());
            const double bpm=beats->getBpmAroundPosition(position,4).value();
            if(bpm<=0) return;
            offset=track->getSampleRate().value()*30.0/bpm*(action=="grid_earlier_half"?-1:1);
        }
        const auto translated=beats->tryTranslate(offset);
        if(translated) track->trySetBeats(*translated);
    }
    std::vector<std::unique_ptr<ControlObject>> m_owners;
    std::array<TrackPointer,2> m_originalTrack;
    std::array<mixxx::BeatsPointer,2> m_originalBeats;
    int m_active=1;
    bool m_grid=false;
};
