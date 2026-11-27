#pragma once

#include <QStackedLayout>
#include <QTimer>
#include <memory>
#include <vector>
#include "control/controlobject.h"
#include "control/controlproxy.h"
#include "mixer/playerinfo.h"
#include "widget/wrx3browser.h"

// Native stacked page: hiding the waveform parent also hides accelerated
// waveform surfaces. The deck footer remains live at its original full size.
class WRx3Info : public QWidget {
  public:
    WRx3Info(Library* library,QWidget* canvas):QWidget(canvas) {
        setObjectName("RX3InfoPage");setStyleSheet("#RX3InfoPage {background:black;}");
        m_browser=static_cast<WRx3Browser*>(canvas->findChild<QWidget*>("RX3NativeBrowser"));
        m_modes=canvas->findChild<QWidget*>("RX3ModeStripContainer");
        auto* area=canvas->findChild<QWidget*>("RX3PerformanceArea");
        if(area && area->layout()) {
            auto* original=new QWidget(area);auto* originalLayout=new QHBoxLayout(original);
            const auto margins=area->layout()->contentsMargins();originalLayout->setContentsMargins(margins);
            originalLayout->setSpacing(area->layout()->spacing());
            while(auto* item=area->layout()->takeAt(0)) {if(item->widget()) originalLayout->addWidget(item->widget());delete item;}
            delete area->layout();m_stack=new QStackedLayout(area);m_stack->setContentsMargins(0,0,0,0);
            m_stack->addWidget(original);m_stack->addWidget(this);
        }
        auto* layout=new QHBoxLayout(this);layout->setContentsMargins(0,0,0,0);layout->setSpacing(8);
        auto* decks=new QVBoxLayout;decks->setSpacing(8);layout->addLayout(decks);
        for(int i=0;i<2;++i) {
            m_decks[i]=new QPushButton(this);m_decks[i]->setObjectName(QString("RX3InfoDeck%1").arg(i+1));
            m_decks[i]->setStyleSheet("QPushButton {background:#202020;color:white;border:1px solid #555;font-family:Arial;font-size:17px;text-align:left;padding:8px;border-top:2px solid #00839E;} QPushButton[chosen=\"true\"] {border:1px solid white;border-top:2px solid #00839E;}");
            m_decks[i]->setFixedWidth(144);m_decks[i]->setMinimumHeight(130);decks->addWidget(m_decks[i]);
            m_decks[i]->setAccessibleName(QString("Inspect deck %1").arg(i+1));
            connect(m_decks[i],&QPushButton::clicked,this,[this,i]{m_deck=i+1;updateTrack();});
        }
        decks->addStretch();
        m_panel=new Rx3TrackInfoPanel(library?library->rekordboxFeature():nullptr,this);layout->addWidget(m_panel,1);
        m_panel->setJump([this](const QString& key,const rx3::InfoTrack& track){if(m_browser) m_browser->infoJump(key,track);});
        if(auto* label=canvas->findChild<QLabel*>("RX3InfoLabel")) {
            m_toggle=new QPushButton("◀ INFO",label->parentWidget());m_toggle->setObjectName("RX3InfoToggle");
            m_toggle->setAccessibleName("Show or hide track information");m_toggle->setStyleSheet("QPushButton {color:#ddd;background:transparent;border:0;font-family:Arial;font-size:16px;} QPushButton[chosen=\"true\"] {color:#007CE0;}");
            if(auto* layout=label->parentWidget()->layout()) {layout->replaceWidget(label,m_toggle);label->hide();}
            connect(m_toggle,&QPushButton::clicked,this,[this]{setOpen(!m_open);});
        }
        make("visible",[this](double value){setOpen(value>0);});
        make("toggle",[this](double value){if(value>0) setOpen(!m_open);});
        make("move",[this](double value){if(m_open && value) activePanel()->move(qRound(value));});
        make("enter",[this](double value){if(m_open && value>0) activePanel()->enter();});
        make("hold",[this](double value){if(m_open) activePanel()->hold(value>0);});
        make("back",[this](double value){if(value>0) setOpen(false);});
        m_tab=std::make_unique<ControlProxy>("[Tab]","current",this,ControlFlag::NoAssertIfMissing);
        m_tab->connectValueChanged(this,[this](double){if(m_open) setOpen(false);});
        m_shortcut=std::make_unique<ControlProxy>("[RX3Shortcut]","visible",this);
        m_shortcut->connectValueChanged(this,[this](double value){if(value>0) setOpen(false);});
        auto* refresh=new QTimer(this);refresh->setInterval(250);
        connect(refresh,&QTimer::timeout,this,[this,library]{if(m_open && !m_browse) updateTrack(library);});refresh->start();
        m_library=library;
        if(m_stack) m_stack->setCurrentIndex(0);else hide();
    }
    void setOpen(bool open) {
        if(open==m_open) return;
        if(open) {
            m_browse=ControlObject::get(ConfigKey("[Tab]","current"))==1;
            if(m_browse && (!m_browser || !m_browser->canShowInfo())) {ControlObject::set(ConfigKey("[RX3Info]","visible"),0);return;}
            if(!m_browse && !m_stack) {ControlObject::set(ConfigKey("[RX3Info]","visible"),0);return;}
            m_deck=ControlObject::get(ConfigKey("[RX3Controller]","active_deck"))==2?2:1;
        } else activePanel()->hold(false);
        m_open=open;
        if(m_browser) m_browser->showTrackInfo(open && m_browse);
        if(m_stack) m_stack->setCurrentIndex(open && !m_browse?1:0);
        if(m_modes) m_modes->setVisible(!(open && !m_browse));
        if(m_toggle) {m_toggle->setProperty("chosen",open);m_toggle->style()->unpolish(m_toggle);m_toggle->style()->polish(m_toggle);}
        ControlObject::set(ConfigKey("[RX3Info]","visible"),open?1:0);
        if(open && !m_browse) updateTrack();
    }
  private:
    Rx3TrackInfoPanel* activePanel() const {return m_browse && m_browser?m_browser->detailedInfo():m_panel;}
    void make(const QString& key,std::function<void(double)> callback) {
        auto control=std::make_unique<ControlObject>(ConfigKey("[RX3Info]",key),false);
        connect(control.get(),&ControlObject::valueChanged,this,[callback](double value){callback(value);});m_controls.push_back(std::move(control));
    }
    void updateTrack(Library* library=nullptr) {
        if(!library) library=m_library;
        auto* feature=library?library->rekordboxFeature():nullptr;
        for(int i=0;i<2;++i) {
            const auto track=PlayerInfo::instance().getTrackInfo(QString("[Channel%1]").arg(i+1));
            auto info=rx3::infoTrack(feature,track?track->getLocation():QString(),track);
            m_decks[i]->setText(QString("DECK %1\n\n%2\n\n%3").arg(i+1)
                .arg(info.record?m_browser?m_browser->infoUsbName(info.root):QString("USB"):QString())
                .arg(info.values.value(5)));
            if(m_decks[i]->property("chosen").toBool()!=(m_deck==i+1)) {m_decks[i]->setProperty("chosen",m_deck==i+1);m_decks[i]->style()->unpolish(m_decks[i]);m_decks[i]->style()->polish(m_decks[i]);}
            if(m_deck==i+1) m_panel->setTrack(info);
        }
    }
    Library* m_library=nullptr;WRx3Browser* m_browser=nullptr;
    QStackedLayout* m_stack=nullptr;QWidget* m_modes=nullptr;Rx3TrackInfoPanel* m_panel;
    QPushButton* m_decks[2];QPushButton* m_toggle=nullptr;bool m_open=false,m_browse=false;int m_deck=1;
    std::vector<std::unique_ptr<ControlObject>> m_controls;
    std::unique_ptr<ControlProxy> m_tab,m_shortcut;
};
