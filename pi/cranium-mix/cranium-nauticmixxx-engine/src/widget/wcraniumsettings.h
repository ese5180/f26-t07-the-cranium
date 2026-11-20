#pragma once

#include <QComboBox>
#include <QFileInfo>
#include <QHBoxLayout>
#include <QLabel>
#include <QPushButton>
#include <QPointer>
#include <QProgressBar>
#include <QScrollArea>
#include <QSignalBlocker>
#include <QStackedWidget>
#include <QTimer>
#include <QVariant>
#include <QVBoxLayout>
#include <functional>

// An embedded page, never a second desktop window. The service callbacks keep
// hardware changes in their owning backend and allow realistic UI regressions.
class CraniumSettings final : public QWidget {
  public:
    struct Services {
        std::function<QVariantList()> controllers;
        std::function<QString()> usbStatus;
        std::function<void(QString, bool)> enableController;
        std::function<void()> refreshControllers;
        std::function<QVariantList(bool)> audioDevices;
        std::function<void(std::function<void(QVariantList,QString)>)> refreshAudio;
        std::function<QVariantMap(int)> deckState;
        std::function<QString(int)> toggleDeck;
        std::function<QVariantMap()> audioRouting;
        std::function<QString(QString, int, QString, int)> applyAudio;
        std::function<bool()> playing;
        std::function<bool()> developer;
        std::function<QString(bool)> setDeveloper;
        std::function<void()> advanced;
        std::function<void()> close;
    };
    explicit CraniumSettings(Services services, QWidget* parent = nullptr)
            : QWidget(parent), m_services(std::move(services)) {
        setObjectName("CraniumSettings");
        setAttribute(Qt::WA_StyledBackground);
        setStyleSheet(
            "#CraniumSettings{background:#080808;color:#fff;}"
            "#CraniumSettings QLabel{color:#eee;font:14px 'DejaVu Sans';}"
            "#CraniumSettings QLabel[muted=true]{color:#aaa;font-size:13px;}"
            "#CraniumSettings QPushButton{background:#161616;color:#eee;border:1px solid #454545;border-radius:5px;min-height:40px;padding:0 14px;font:bold 13px 'DejaVu Sans';}"
            "#CraniumSettings QPushButton:checked,#CraniumSettings QPushButton[primary=true]{background:#eee;color:#080808;border-color:#eee;}"
            "#CraniumSettings QPushButton:disabled{color:#666;border-color:#272727;}"
            "#CraniumSettings QComboBox{background:#181818;color:#fff;border:1px solid #454545;border-radius:5px;min-height:38px;padding:0 10px;font:14px 'DejaVu Sans';}"
            "#CraniumSettings QComboBox QAbstractItemView{background:#181818;color:white;selection-background-color:#ddd;selection-color:#080808;min-height:36px;}"
            "#CraniumSettings QScrollArea,#CraniumSettings QScrollArea>QWidget>QWidget{background:#080808;border:0;}"
            "#CraniumSettings QProgressBar{background:#222;border:0;}"
            "#CraniumSettings QProgressBar::chunk{background:#eee;}"
            "#CraniumSettings QScrollBar:vertical{background:#111;width:12px;}"
            "#CraniumSettings QScrollBar::handle:vertical{background:#555;min-height:32px;}");
        auto* root = new QVBoxLayout(this); root->setContentsMargins(20,12,20,12); root->setSpacing(10);
        auto* header = new QHBoxLayout;
        auto* brand = new QLabel("C R A N I U M", this); brand->setObjectName("CraniumSettingsBrand");
        brand->setStyleSheet("font:bold 22px 'DejaVu Sans';color:#fff;"); header->addWidget(brand);
        header->addStretch(); auto* back = button("‹  BACK", "CraniumSettingsBack", this);
        header->addWidget(back); root->addLayout(header);
        connect(back,&QPushButton::clicked,this,[this]{if(m_services.close)m_services.close();});
        auto* tabs = new QHBoxLayout; tabs->setSpacing(8);
        for (const auto& name : {"CONTROLLER", "AUDIO", "SYSTEM"}) {
            const int page = m_tabs.size(); auto* tab = button(name,QString("CraniumSettingsTab%1").arg(page),this);
            tab->setCheckable(true);m_tabs.append(tab);tabs->addWidget(tab);
            connect(tab,&QPushButton::clicked,this,[this,page]{openPage(page);});
        }
        root->addLayout(tabs);m_pages = new QStackedWidget(this);root->addWidget(m_pages,1);
        auto* controller = page();
        label(controller,"CONTROLLER CONNECTION",false,true);
        m_usb = label(controller,{},true);
        m_controller = new QComboBox(this);m_controller->setObjectName("CraniumControllerSelect");controller->addWidget(m_controller);
        m_controllerDetail = label(controller,{});
        auto* row = new QHBoxLayout;
        m_enable = button("ENABLE CONTROLLER","CraniumControllerEnable",this);m_enable->setProperty("primary",true);row->addWidget(m_enable);
        auto* refresh = button("CHECK CONNECTION","CraniumControllerRefresh",this);row->addWidget(refresh);controller->addLayout(row);
        label(controller,"Use the computer / phone USB-C port and a USB data cable. Power alone does not confirm a data connection.",true);
        controller->addStretch();
        connect(m_controller,qOverload<int>(&QComboBox::currentIndexChanged),this,[this]{updateControllerDetail();});
        connect(m_enable,&QPushButton::clicked,this,[this]{
            const auto entry=m_controller->currentData().toMap();if(entry.isEmpty())return;
            if(m_services.enableController)m_services.enableController(entry["name"].toString(),!entry["enabled"].toBool());
            notice("Applying controller setting…");m_connectionTimer->start();});
        m_connectionTimer=new QTimer(this);m_connectionTimer->setSingleShot(true);m_connectionTimer->setInterval(3000);
        connect(m_connectionTimer,&QTimer::timeout,this,[this]{refreshController();const auto entry=m_controller->currentData().toMap();
            notice(entry.isEmpty()?"No controller detected. Check the USB data cable.":entry["enabled"].toBool()?"Controller connected.":"Controller detected. Tap ENABLE CONTROLLER to connect.");});
        connect(refresh,&QPushButton::clicked,this,[this]{if(m_services.refreshControllers)m_services.refreshControllers();notice("Checking USB and MIDI connection…");refreshController();m_connectionTimer->start();});
        auto* audio = page();
        label(audio,"AUDIO OUTPUTS",false,true);
        label(audio,"Choose where the master mix and headphone cue are sent.",true);
        m_mainDevice=routeRow(audio,"MASTER", "CraniumMainDevice", &m_mainPair);
        m_headDevice=routeRow(audio,"HEADPHONES", "CraniumHeadphonesDevice", &m_headPair);
        auto* audioRow=new QHBoxLayout;
        m_apply=button("SAVE AUDIO SETUP","CraniumAudioApply",this);m_apply->setProperty("primary",true);audioRow->addWidget(m_apply);
        m_audioRefresh=button("REFRESH DEVICES","CraniumAudioRefresh",this);audioRow->addWidget(m_audioRefresh);audio->addLayout(audioRow);
        label(audio,"FLX4: master channels 1–2 · headphones channels 3–4. Stop playback before changing audio devices.",true);
        audio->addStretch();
        auto* transport=new QHBoxLayout;
        for(int deck=1;deck<=2;++deck){auto* play=button(QString("DECK %1 · PLAY").arg(deck),QString("CraniumDeck%1Play").arg(deck),this);m_deckPlay.append(play);transport->addWidget(play);
            connect(play,&QPushButton::clicked,this,[this,deck]{if(m_services.toggleDeck){const auto error=m_services.toggleDeck(deck);if(!error.isEmpty())notice(error);updateTransport();updateAudioActions();}});}
        audio->insertLayout(audio->count()-1,transport);
        connect(m_apply,&QPushButton::clicked,this,[this]{
            if(isPlaying()){notice("Stop playback before changing audio setup.");return;}
            if(!m_services.applyAudio||m_audioBusy)return;
            setAudioBusy(true,"Saving audio setup…");
            // Let the progress state paint before the driver applies routing.
            QTimer::singleShot(50,this,[this]{
                const auto error=m_services.applyAudio(m_mainDevice->currentData().toString(),m_mainPair->currentData().toInt(),
                        m_headDevice->currentData().toString(),m_headPair->currentData().toInt());
                setAudioBusy(false,error.isEmpty()?"Audio setup saved.":error);
            });
        });
        connect(m_audioRefresh,&QPushButton::clicked,this,[this]{
            if(isPlaying()){notice("Stop playback before refreshing audio devices.");return;}
            if(m_audioBusy)return;
            setAudioBusy(true,"Refreshing audio devices…");
            if(!m_services.refreshAudio){setAudioBusy(false,"Audio refresh is unavailable. Your current setup is unchanged.");return;}
            QPointer<CraniumSettings> guard(this);
            m_services.refreshAudio([guard](QVariantList devices,QString error){
                if(!guard)return;
                if(error.isEmpty()){guard->m_audio=std::move(devices);guard->populateAudio();}
                guard->setAudioBusy(false,error.isEmpty()?(guard->m_audio.isEmpty()?"No audio output devices found.":"Audio devices refreshed."):error);
            });
        });
        auto* system=page();
        label(system,"CRANIUM",false,true);
        label(system,"A focused DJ interface. Desktop tools stay hidden during normal use.",true);
        auto* developer=button("DEVELOPER TOOLS  ›","CraniumDeveloperTools",this);system->addWidget(developer);
        m_developerText=label(system,"Desktop mode is temporary and resets on the next boot.",true);
        m_hold=button("HOLD 2 SECONDS TO ENTER DESKTOP","CraniumDeveloperHold",this);m_hold->hide();system->addWidget(m_hold);
        m_return=button("RETURN TO CRANIUM MODE","CraniumReturnToKiosk",this);m_return->hide();system->addWidget(m_return);
        m_advanced=button("ADVANCED PREFERENCES","CraniumAdvancedPreferences",this);m_advanced->hide();system->addWidget(m_advanced);system->addStretch();
        m_holdTimer=new QTimer(this);m_holdTimer->setSingleShot(true);m_holdTimer->setInterval(2000);
        connect(developer,&QPushButton::clicked,this,[this]{m_developerExpanded=true;updateDeveloper();});
        connect(m_hold,&QPushButton::pressed,this,[this]{m_holdTimer->start();m_hold->setText("KEEP HOLDING…");});
        connect(m_hold,&QPushButton::released,this,[this]{m_holdTimer->stop();m_hold->setText("HOLD 2 SECONDS TO ENTER DESKTOP");});
        connect(m_holdTimer,&QTimer::timeout,this,[this]{if(m_services.setDeveloper){notice(m_services.setDeveloper(true));updateDeveloper();}});
        connect(m_return,&QPushButton::clicked,this,[this]{if(m_services.setDeveloper){notice(m_services.setDeveloper(false));updateDeveloper();}});
        connect(m_advanced,&QPushButton::clicked,this,[this]{if(m_services.developer&&m_services.developer()&&m_services.advanced)m_services.advanced();});
        m_progress=new QProgressBar(this);m_progress->setObjectName("CraniumSettingsProgress");m_progress->setRange(0,0);m_progress->setTextVisible(false);m_progress->setFixedHeight(5);m_progress->hide();root->addWidget(m_progress);
        m_notice=new QLabel(this);m_notice->setObjectName("CraniumSettingsNotice");m_notice->setWordWrap(true);m_notice->setMinimumHeight(20);root->addWidget(m_notice);
        auto* timer=new QTimer(this);timer->setInterval(700);
        connect(timer,&QTimer::timeout,this,[this]{if(!isVisible())return;refreshController();updateDeveloper();updateAudioActions();updateTransport();});timer->start();
    }
    void openPage(int index){m_holdTimer->stop();m_connectionTimer->stop();m_pages->setCurrentIndex(qBound(0,index,2));for(int i=0;i<m_tabs.size();++i)m_tabs[i]->setChecked(i==index);if(!m_audioBusy)notice({});refreshController();if(index==1&&!m_audioBusy)refreshAudio(false);updateDeveloper();updateTransport();}
    void notice(QString text){m_notice->setText(std::move(text));}
  private:
    QPushButton* button(QString text,QString name,QWidget* parent){auto* value=new QPushButton(text,parent);value->setObjectName(name);return value;}
    QVBoxLayout* page(){auto* scroll=new QScrollArea(this);scroll->setWidgetResizable(true);scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);auto* content=new QWidget;auto* layout=new QVBoxLayout(content);layout->setContentsMargins(0,8,8,0);layout->setSpacing(12);scroll->setWidget(content);m_pages->addWidget(scroll);return layout;}
    QLabel* label(QVBoxLayout* layout,QString text,bool muted=false,bool heading=false){auto* value=new QLabel(text,this);value->setWordWrap(true);value->setProperty("muted",muted);if(heading)value->setStyleSheet("font:bold 15px 'DejaVu Sans';color:white;");layout->addWidget(value);return value;}
    bool isPlaying()const{return m_services.playing&&m_services.playing();}
    QComboBox* routeRow(QVBoxLayout* layout,QString title,QString name,QComboBox** pair){
        auto* row=new QHBoxLayout;auto* caption=new QLabel(title,this);caption->setFixedWidth(110);row->addWidget(caption);
        auto* device=new QComboBox(this);device->setObjectName(name);device->setMinimumWidth(160);row->addWidget(device,1);
        *pair=new QComboBox(this);(*pair)->setObjectName(name+"Channels");(*pair)->setFixedWidth(110);row->addWidget(*pair);layout->addLayout(row);
        connect(device,qOverload<int>(&QComboBox::currentIndexChanged),this,[this,device,pairWidget=*pair]{updatePairs(device,pairWidget);});return device;
    }
    void updatePairs(QComboBox* device,QComboBox* pairs){const int old=pairs->currentData().toInt();QSignalBlocker block(pairs);pairs->clear();int count=0;for(const auto& value:m_audio){const auto entry=value.toMap();if(entry["id"].toString()==device->currentData().toString())count=entry["channels"].toInt();}for(int base=0;base+1<count;base+=2)pairs->addItem(QString("%1–%2").arg(base+1).arg(base+2),base);const auto index=pairs->findData(old);if(index>=0)pairs->setCurrentIndex(index);}
    void refreshAudio(bool rescan){
        if(!m_services.audioDevices)return;m_audio=m_services.audioDevices(rescan);populateAudio();
    }
    void populateAudio(){const auto current=m_services.audioRouting?m_services.audioRouting():QVariantMap();
        for(auto* box:{m_mainDevice,m_headDevice}){QSignalBlocker block(box);box->clear();box->addItem("Not assigned",QString());for(const auto& value:m_audio){const auto entry=value.toMap();box->addItem(entry["name"].toString(),entry["id"]);}const auto key=box==m_mainDevice?"main":"headphones";const int index=box->findData(current[key]);if(index>=0)box->setCurrentIndex(index);}
        updatePairs(m_mainDevice,m_mainPair);updatePairs(m_headDevice,m_headPair);
        for(auto pair:{qMakePair(m_mainPair,"mainBase"),qMakePair(m_headPair,"headphonesBase")}){const int i=pair.first->findData(current[pair.second]);if(i>=0)pair.first->setCurrentIndex(i);}
        updateAudioActions();updateTransport();
    }
    void refreshController(){
        if(m_services.usbStatus)m_usb->setText(m_services.usbStatus());const auto entries=m_services.controllers?m_services.controllers():QVariantList();
        if(entries==m_controllerEntries && m_controller->count()>0){updateControllerDetail();return;}
        m_controllerEntries=entries;
        const QString selected=m_controller->currentData().toMap()["name"].toString();QSignalBlocker block(m_controller);m_controller->clear();int selectedIndex=0;
        for(const auto& value:entries){const auto entry=value.toMap();if(entry["name"].toString()==selected)selectedIndex=m_controller->count();m_controller->addItem(entry["name"].toString(),entry);}
        if(entries.isEmpty())m_controller->addItem("No MIDI controller detected");else m_controller->setCurrentIndex(selectedIndex);updateControllerDetail();
    }
    void updateControllerDetail(){const auto entry=m_controller->currentData().toMap();m_enable->setEnabled(!entry.isEmpty());
        if(entry.isEmpty()){m_controllerDetail->setText("Waiting for a USB MIDI connection. No mapping can be enabled until a controller is detected.");m_enable->setText("ENABLE CONTROLLER");return;}
        const bool enabled=entry["enabled"].toBool();m_enable->setText(enabled?"DISABLE CONTROLLER":"ENABLE CONTROLLER");
        m_controllerDetail->setText(QString("%1  ·  %2\n%3").arg(enabled?"MIDI connected":"MIDI detected, disabled",entry["output"].toBool()?"LED output available":"No MIDI output port",entry["mapping"].toString()));}
    void updateAudioActions(){const bool blocked=isPlaying()||m_audioBusy;m_apply->setEnabled(!blocked);m_audioRefresh->setEnabled(!blocked);for(auto* box:{m_mainDevice,m_headDevice,m_mainPair,m_headPair})box->setEnabled(!m_audioBusy);}
    void setAudioBusy(bool busy,QString message){m_audioBusy=busy;m_progress->setVisible(busy);m_audioRefresh->setText(busy?"PLEASE WAIT…":"REFRESH DEVICES");notice(std::move(message));updateAudioActions();}
    void updateTransport(){for(int index=0;index<m_deckPlay.size();++index){const auto state=m_services.deckState?m_services.deckState(index+1):QVariantMap();auto* button=m_deckPlay[index];button->setEnabled(state["loaded"].toBool()&&!m_audioBusy);button->setText(QString("DECK %1 · %2").arg(index+1).arg(state["playing"].toBool()?"PAUSE":"PLAY"));button->setToolTip(state["loaded"].toBool()?"Play or pause the loaded track":"Load a track first");}}
    void updateDeveloper(){const bool active=m_services.developer&&m_services.developer();m_hold->setVisible(m_developerExpanded&&!active);m_return->setVisible(active);m_advanced->setVisible(active);m_developerText->setText(active?"DEVELOPER MODE ACTIVE · desktop tools are available.":"Desktop mode is temporary and resets on the next boot.");}
    Services m_services;QList<QPushButton*>m_tabs;QStackedWidget*m_pages;QLabel*m_usb,*m_controllerDetail,*m_notice,*m_developerText;QComboBox*m_controller,*m_mainDevice,*m_headDevice,*m_mainPair,*m_headPair;QPushButton*m_enable,*m_apply,*m_audioRefresh,*m_hold,*m_return,*m_advanced;QTimer*m_holdTimer,*m_connectionTimer;QProgressBar*m_progress;QVariantList m_audio,m_controllerEntries;QList<QPushButton*>m_deckPlay;bool m_developerExpanded=false,m_audioBusy=false;
};
