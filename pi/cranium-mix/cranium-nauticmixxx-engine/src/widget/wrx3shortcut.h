#pragma once

#include <QFile>
#include <QSaveFile>
#include <QLockFile>
#include <QStorageInfo>
#include <QApplication>
#include <QDir>
#include <QStyle>
#include <QMessageBox>
#include <algorithm>
#include <array>
#include <vector>
#include <QFrame>
#include <QGridLayout>
#include <QLabel>
#include <QPainterPath>
#include <QPushButton>
#include <QPointer>
#include <QTimer>
#include <QVBoxLayout>
#include <cmath>
#include <functional>
#include "control/controlobject.h"
#include "control/controlproxy.h"
#include "effects/effectsmanager.h"
#include "effects/chains/equalizereffectchain.h"
#include "effects/effectslot.h"
#include "effects/backends/effectsbackendmanager.h"
#include "mixer/basetrackplayer.h"
#include "engine/controls/cuecontrol.h"
#include "preferences/dialog/dlgprefdeck.h"
#include "preferences/usersettings.h"
#include "waveform/waveformwidgetfactory.h"
#include "widget/rx3mysettings.h"
#include "widget/rx3mysettingswriter.h"
#include <QFutureWatcher>
#include <QtConcurrentRun>

class Rx3CurveButton : public QPushButton {
  public:
    Rx3CurveButton(int shape,bool cross,QWidget* parent):QPushButton(parent),m_shape(shape),m_cross(cross) {
        setAccessibleName((cross?QStringLiteral("Crossfader "):QStringLiteral("Channel fader "))+
                QStringList{"smooth","linear","sharp"}[shape]);
    }
  protected:
    void paintEvent(QPaintEvent* event) override {
        QPushButton::paintEvent(event);
        QPainter painter(this);painter.setRenderHint(QPainter::Antialiasing);
        QPainterPath path;const auto area=QRectF(rect()).adjusted(14,9,-14,-9);
        path.moveTo(area.bottomLeft());
        for(int i=0;i<=32;++i) {
            const double x=i/32.0;
            const double y=m_cross ? std::min(1.0,x*(m_shape==0?1:m_shape==1?3:12)) :
                    m_shape==0?x*x:m_shape==1?x:std::sqrt(x);
            path.lineTo(area.left()+area.width()*x,area.bottom()-area.height()*y);
        }
        path.lineTo(area.bottomRight());path.closeSubpath();
        painter.fillPath(path,Qt::white);
    }
  private:
    int m_shape;bool m_cross;
};

class Rx3WaveformColorButton : public QPushButton {
  public:
    Rx3WaveformColorButton(int color,QWidget* parent)
            :QPushButton(parent),m_color(color) {
        setAccessibleName(QStringList{"BLUE","RGB","3BAND"}.at(color));
    }
  protected:
    void paintEvent(QPaintEvent* event) override {
        QPushButton::paintEvent(event);
        QPainter painter(this);
        const QRectF chip(width()*0.22,height()*0.16,width()*0.56,height()*0.32);
        if(m_color==0) painter.fillRect(chip,QColor("#80B8F1"));
        else if(m_color==1) {
            const QStringList colors={"#E74B30","#EF9B38","#EFD64A","#7ABF68","#68BFC7","#3C78DA","#574BC2","#9B60AF"};
            for(int i=0;i<colors.size();++i) painter.fillRect(
                    QRectF(chip.x()+chip.width()*i/colors.size(),chip.y(),chip.width()/colors.size()+0.5,chip.height()),QColor(colors[i]));
        } else {
            const QStringList colors={"#FFFFFF","#F3C966","#80B8F1"};
            for(int i=0;i<3;++i) painter.fillRect(QRectF(chip.x()+chip.width()*i/3,chip.y(),chip.width()/3+0.5,chip.height()),QColor(colors[i]));
        }
        painter.setPen(QColor("#333333"));painter.drawRect(chip);
        QFont font("Arial");font.setPixelSize(qRound(height()*0.32));painter.setFont(font);painter.setPen(Qt::white);
        painter.drawText(QRectF(2,height()*0.51,width()-4,height()*0.44),Qt::AlignCenter,accessibleName());
    }
  private:
    int m_color;
};

// Settings and their controls belong to this skin instance. Engine controls
// remain authoritative; closing SHORTCUT only hides the presentation layer.
class WRx3Shortcut : public QFrame {
  public:
    WRx3Shortcut(UserSettingsPointer config,EffectsManager* effects,QWidget* parent)
            : QFrame(parent),m_config(std::move(config)),m_effects(effects) {
        setObjectName("RX3Shortcut");setAttribute(Qt::WA_StyledBackground);
        setStyleSheet("#RX3Shortcut {background:#000000;color:#fff;} "
                "#RX3Shortcut QLabel {color:#fff;background:transparent;font-family:Arial;font-size:14px;} "
                "#RX3Shortcut QLabel[section=\"true\"] {border-bottom:1px solid #a9a9ad;font-size:15px;} "
                "#RX3Shortcut QFrame[encoderFocus=\"true\"] {border:1px solid white;} "
                "#RX3Shortcut QFrame[encoderFocus=\"false\"] {border:1px solid transparent;} "
                "#RX3Shortcut QPushButton {background:#202020;color:white;border:1px solid #ddd;"
                "font-family:Arial;font-size:16px;font-weight:normal;padding:3px;} "
                "#RX3Shortcut QPushButton[chosen=\"true\"] {background:#007CE0;} "
                "#RX3Shortcut QPushButton:disabled {color:#999;border-color:#888;} "
                "#RX3Shortcut QLabel#ShortcutStatus {font-size:12px;color:#ddd;}");
        auto* layout=new QVBoxLayout(this);layout->setContentsMargins(20,12,20,12);layout->setSpacing(9);
        layout->setSizeConstraint(QLayout::SetNoConstraint);
        auto* titleRow=new QHBoxLayout;
        auto* title=new QLabel("SHORTCUT",this);title->setStyleSheet("font-size:20px;font-weight:bold;");
        titleRow->addWidget(title);titleRow->addStretch();
        auto* closeFrame=new QFrame(this);closeFrame->setObjectName("ShortcutRow_close");
        closeFrame->setAttribute(Qt::WA_StyledBackground);closeFrame->setFixedHeight(30);
        auto* closeLayout=new QVBoxLayout(closeFrame);closeLayout->setContentsMargins(0,0,0,0);
        auto* close=new QPushButton("CLOSE",closeFrame);close->setObjectName("ShortcutClose");
        closeLayout->addWidget(close);
        connect(close,&QPushButton::clicked,this,[this]{setVisibleControl(false);});titleRow->addWidget(closeFrame);
        layout->addLayout(titleRow);
        auto* columns=new QHBoxLayout;columns->setSpacing(24);layout->addLayout(columns,1);
        auto* left=new QVBoxLayout;auto* right=new QVBoxLayout;left->setSpacing(4);right->setSpacing(12);
        columns->addLayout(left,3);columns->addLayout(right,2);
        section(left,"DECK SETTING");
        auto* deckTop=new QHBoxLayout;left->addLayout(deckTop);
        add(deckTop,"TIME","time_mode",{"TIME","REMAIN"},{0,1},1);
        add(deckTop,"AUTO CUE","auto_cue",{"ON","OFF"},{1,0},1);
        add(deckTop,"LOAD LOCK","load_lock",{"LOCK","UNLOCK"},{1,0},1);
        auto* deckBottom=new QHBoxLayout;left->addLayout(deckBottom);
        add(deckBottom,"QUANTIZE BEAT VALUE","quantize_beat",{"1/8","1/4","1/2","1"},{0.125,0.25,0.5,1},1);
        add(deckBottom,"HOT CUE AUTO LOAD","hotcue_autoload",{"ON","SETTING","OFF"},{0,1,2},0);
        section(left,"JOG RESPONSE");
        auto* jog=new QHBoxLayout;left->addLayout(jog);
        add(jog,"SCRATCH SENSITIVITY","scratch_sensitivity",{"1","2","3","4","5"},{1,2,3,4,5},3,true);
        add(jog,"PITCH BEND","pitch_bend",{"1","2","3","4","5"},{1,2,3,4,5},3,true);
        section(left,"PLAYBACK SETTINGS");
        for(int deck=1;deck<=2;++deck) {
            auto* row=new QHBoxLayout;left->addLayout(row);
            const auto group=QString("[Channel%1]").arg(deck);
            add(row,QString("DECK %1 MASTER TEMPO").arg(deck),QString("master_tempo%1").arg(deck),
                    {"ON","OFF"},{1,0},ControlObject::get(ConfigKey(group,"keylock")));
            add(row,QString("DECK %1 TEMPO RANGE").arg(deck),QString("tempo_range%1").arg(deck),
                    {"6%","10%","16%","WIDE"},{0.06,0.10,0.16,1},0.06);
        }
        section(left,"VINYL SPEED ADJUST (TOUCH)");
        auto* vinyl=new QHBoxLayout;left->addLayout(vinyl);
        for(int deck=1;deck<=2;++deck) {
            auto* column=new QVBoxLayout;vinyl->addLayout(column);
            add(column,QString("DECK %1").arg(deck),QString("vinyl_speed%1").arg(deck),{"ON","OFF"},{1,0},0);
            add(column,"STOP TIME",QString("vinyl_stop%1").arg(deck),{"1","2","3","4","5"},{1,2,3,4,5},3,true);
        }
        left->addStretch(1);
        auto* usb=new QFrame(this);usb->setObjectName("ShortcutUsbBlock");
        usb->setAttribute(Qt::WA_StyledBackground);
        usb->setStyleSheet("#ShortcutUsbBlock {background:#202020;border:0;border-top:2px solid #00839E;}");
        right->addWidget(usb);
        auto* usbColumn=new QVBoxLayout(usb);usbColumn->setContentsMargins(0,2,0,0);usbColumn->setSpacing(0);
        m_source=new QLabel("SOURCE — SELECT USB",usb);m_source->setObjectName("ShortcutUsbSlot");
        m_source->setFixedHeight(36);m_source->setContentsMargins(14,0,14,0);usbColumn->addWidget(m_source);
        auto separator=[usbColumn,usb](int height) {
            auto* row=new QHBoxLayout;row->setContentsMargins(12,0,12,0);
            auto* line=new QWidget(usb);line->setObjectName("ShortcutUsbSeparator");
            line->setFixedHeight(height);line->setStyleSheet("background:#000000;");
            row->addWidget(line);usbColumn->addLayout(row);
        };
        separator(1);
        m_deviceName=new QLabel(usb);m_deviceName->setObjectName("ShortcutUsbDeviceName");
        m_deviceName->setFixedHeight(32);m_deviceName->setContentsMargins(14,0,14,0);usbColumn->addWidget(m_deviceName);
        separator(2);
        auto* sourceRow=new QHBoxLayout;sourceRow->setContentsMargins(0,0,0,0);sourceRow->setSpacing(0);usbColumn->addLayout(sourceRow);
        add(sourceRow,"WAVEFORM COLOR","waveform_color",{"BLUE","RGB","3BAND"},{0,1,2},2);
        m_rows.back().frame->setFixedHeight(74);
        m_rows.back().frame->layout()->setContentsMargins(8,6,8,6);
        auto* loadFrame=new QFrame(usb);loadFrame->setObjectName("ShortcutRow_usb_load");
        loadFrame->setStyleSheet("#ShortcutRow_usb_load {background:#191919;}");
        loadFrame->setAttribute(Qt::WA_StyledBackground);loadFrame->setProperty("encoderFocus",false);
        loadFrame->setFixedHeight(74);sourceRow->addWidget(loadFrame);
        auto* loadColumn=new QVBoxLayout(loadFrame);loadColumn->setContentsMargins(10,6,6,6);loadColumn->setSpacing(2);
        auto* loadCaption=new QLabel("MY SETTINGS",loadFrame);loadCaption->setFixedHeight(16);loadColumn->addWidget(loadCaption);
        m_load=new QPushButton("LOAD",loadFrame);m_load->setFixedHeight(36);m_load->setObjectName("ShortcutSettingsLoad");
        auto* settingsActions=new QHBoxLayout;loadColumn->addLayout(settingsActions);settingsActions->addWidget(m_load);
        connect(m_load,&QPushButton::clicked,this,[this]{loadSettings();});
        // Include LOAD in encoder focus order; it is an action, not a value.
        auto* save=new QPushButton("SAVE",loadFrame);settingsActions->addWidget(save);save->setFixedHeight(36);save->setObjectName("ShortcutSettingsSave");
        connect(save,&QPushButton::clicked,this,[this]{saveSettings();});
        Row saveRow;saveRow.key="usb_save";saveRow.frame=loadFrame;saveRow.buttons={save};m_rows.push_back(saveRow);
        Row loadRow;loadRow.key="usb_load";loadRow.frame=loadFrame;
        loadRow.buttons={m_load};m_rows.push_back(loadRow);
        auto* toolsFrame=new QFrame(this);auto* toolsLayout=new QVBoxLayout(toolsFrame);toolsLayout->setContentsMargins(0,0,0,0);
        auto* tools=new QPushButton("UTILITY",toolsFrame);
        toolsLayout->addWidget(tools);toolsFrame->setFixedHeight(30);titleRow->insertWidget(titleRow->count()-1,toolsFrame);connect(tools,&QPushButton::clicked,this,[this]{openTools();});
        Row toolsRow;toolsRow.key="browser_tools";toolsRow.frame=toolsFrame;toolsRow.buttons={tools};m_rows.push_back(toolsRow);
        Row closeRow;closeRow.key="close";closeRow.frame=closeFrame;closeRow.buttons={close};m_rows.push_back(closeRow);
        section(right,"MIXER SETTING");
        auto* mixerTop=new QHBoxLayout;right->addLayout(mixerTop);
        add(mixerTop,"EQ / ISO","eq_mode",{"EQ","ISO"},{0,1},0);
        add(mixerTop,"QUANTIZE (EFFECT)","effect_quantize",{"ON","OFF"},{1,0},1);
        auto* mixerBottom=new QHBoxLayout;right->addLayout(mixerBottom);
        add(mixerBottom,"HEADPHONES","headphones",{"MONO\nSPLIT","STEREO"},{1,0},0);
        add(mixerBottom,"CROSSFADER CURVE","crossfader_curve",{"SMOOTH","LINEAR","SHARP"},{0,1,2},0,false,true);
        add(right,"CHANNEL FADER CURVE","channel_curve",{"SMOOTH","LINEAR","SHARP"},{0,1,2},1,false,true);
        add(right,"NEEDLE LOCK","needle_lock",{"LOCK","UNLOCK"},{1,0},1);
        add(right,"SLIP FLASHING","slip_flashing",{"ON","OFF"},{1,0},1);
        right->addStretch(1);
        m_status=new QLabel("",this);m_status->setMaximumHeight(40);m_status->setObjectName("ShortcutStatus");m_status->setWordWrap(true);
        auto* statusRow=new QHBoxLayout;statusRow->addWidget(m_status,1);
        m_details=new QPushButton("DETAILS",this);m_details->hide();statusRow->addWidget(m_details);
        connect(m_details,&QPushButton::clicked,this,[this]{QMessageBox::information(this,"MY SETTINGS",m_status->toolTip());});
        layout->addLayout(statusRow);
        for(const auto& key:{"play_mode","eject_lock"}) ensure("[RX3Settings]",key,m_config->getValue<double>(ConfigKey("[RX3Settings]",key),1));
        for(const auto& item:{"visible","toggle","move","enter","open","load","restore"}) ensure("[RX3Shortcut]",item,0);
        auto bind=[this](const QString& key,std::function<void(double)> action) {
            auto* proxy=new ControlProxy("[RX3Shortcut]",key,this);proxy->connectValueChanged(this,std::move(action));
        };
        bind("visible",[this](double value){
            const bool visible=value>0;
            if(visible && !m_presenting) {
                m_previousTab=ControlObject::get(ConfigKey("[Tab]","current"));m_presenting=true;
                ControlObject::set(ConfigKey("[Tab]","current"),1);
            }
            setVisible(visible);
            if(visible) {m_editing=false;m_focused=0;place();queuePlacement();raise();refresh();}
            else if(m_presenting) {
                m_presenting=false;ControlObject::set(ConfigKey("[Tab]","current"),m_previousTab);
            }
        });
        bind("toggle",[this](double value){if(value>0) setVisibleControl(!isVisible());});
        bind("move",[this](double value){if(value!=0 && isVisible()) move(qRound(value));});
        bind("enter",[this](double value){if(value>0 && isVisible()) enter();});
        bind("open",[this](double value){if(value>0) {setVisibleControl(true);for(int i=0;i<int(m_rows.size());++i) if(m_rows[i].key=="usb_load") m_focused=i;refresh();}});
        bind("load",[this](double value){if(value>0) {setVisibleControl(true);loadSettings();}});
        bind("restore",[this](double value){if(value>0) restore();});
        for(int deck=1;deck<=2;++deck) {
            const auto group=QString("[Channel%1]").arg(deck);
            for(const auto& key:{"rx3_time_remaining","rx3_auto_cue","rx3_auto_cue_level"}) {
                if(!ControlObject::exists(ConfigKey(group,key))) continue;
                const auto saved=ConfigKey("[RX3Settings]",QString("%1%2").arg(key).arg(deck));
                if(m_config->exists(saved)) ControlObject::set(ConfigKey(group,key),m_config->getValue<double>(saved));
                auto* input=new ControlProxy(group,key,this);
                input->connectValueChanged(this,[this,saved](double value){m_config->setValue(saved,value);m_config->save();});
            }
        }
        parent->installEventFilter(this);
        auto* timer=new QTimer(this);timer->setInterval(150);
        connect(timer,&QTimer::timeout,this,[this]{if(isVisible()) refresh();});timer->start();

        for(int deck=1;deck<=2;++deck) {
            const auto group=QString("[Channel%1]").arg(deck);
            const auto key=ConfigKey("[RX3Settings]",QString("quantize%1").arg(deck));
            if(m_config->exists(key)) ControlObject::set(ConfigKey(group,"quantize"),m_config->getValue<double>(key));
        }
        hide();
    }
    void setVisibleControl(bool visible) {
        if(visible) ControlObject::set(ConfigKey("[RX3Controller]","grid_mode"),0);
        ControlObject::set(ConfigKey("[RX3Shortcut]","visible"),visible?1:0);
    }
    void move(int ticks) {
        if(m_rows.empty()) return;
        auto& row=m_rows[m_focused];
        if(m_editing) {
            const int index=selected(row);
            choose(row,std::clamp(index+ticks,0,int(row.values.size())-1));
        } else m_focused=std::clamp(m_focused+ticks,0,int(m_rows.size())-1);
        refresh();
    }
    void openTools() {
        setVisibleControl(false);
        ControlObject::set(ConfigKey("[RX3Browser]","tools"),1);ControlObject::set(ConfigKey("[RX3Browser]","tools"),0);
    }
    void enter() {
        if(m_rows[m_focused].key=="browser_tools") {openTools();return;}
        if(m_rows[m_focused].key=="close") {setVisibleControl(false);return;}
        if(m_rows[m_focused].key=="usb_save") {saveSettings();return;}
        if(m_rows[m_focused].key=="usb_load") {loadSettings();return;}
        m_editing=!m_editing;refresh();
    }
    void restore() {
        QMap<QString,double> deckSettings;
        for(int deck=1;deck<=2;++deck) for(const auto& key:{"rx3_time_remaining","rx3_auto_cue","rx3_auto_cue_level"}) {
            const auto saved=ConfigKey("[RX3Settings]",QString("%1%2").arg(key).arg(deck));
            if(m_config->exists(saved)) deckSettings.insert(QString("%1%2").arg(key).arg(deck),m_config->getValue<double>(saved));
        }
        for(auto& row:m_rows) if(!row.values.isEmpty()) apply(row.key,ControlObject::get(ConfigKey("[RX3Settings]",row.key)));
        for(int deck=1;deck<=2;++deck) {
            const auto key=ConfigKey("[RX3Settings]",QString("quantize%1").arg(deck));
            if(m_config->exists(key)) ControlObject::set(ConfigKey(QString("[Channel%1]").arg(deck),"quantize"),m_config->getValue<double>(key));
        }
        for(auto it=deckSettings.cbegin();it!=deckSettings.cend();++it) {
            const QString group=QString("[Channel%1]").arg(it.key().right(1));
            const ConfigKey key(group,it.key().left(it.key().size()-1));
            if(ControlObject::exists(key)) ControlObject::set(key,it.value());
        }
        refresh();
    }
    QString loadSettings(const QString& sourceRoot = {}) {
        if(m_savingSettings) return status("Wait for MY SETTINGS save to finish before loading.");
        for(int deck=1;deck<=2;++deck) if(ControlObject::get(ConfigKey(QString("[Channel%1]").arg(deck),"play"))>0)
            return status("Pause both decks before loading MY SETTINGS.");
        const auto root=sourceRoot.isNull()?qApp->property("rx3SettingsUsbRoot").toString():sourceRoot;
        if(root.isEmpty() || !QDir(root).exists()) return status("Select a connected USB device in SOURCE first.");
        QMap<QString,double> pending;QStringList omitted;int files=0;
        for(const auto& name:{"MYSETTING.DAT","MYSETTING2.DAT","DJMMYSETTING.DAT","DEVSETTING.DAT"}) {
            QFile file(QDir(root).filePath(QString("PIONEER/")+name));
            if(!file.exists()) continue;
            if(!file.open(QIODevice::ReadOnly) || file.size()>4096) return status(QString("Unable to read ")+name);
            const auto result=rx3::readMySettings(name,file.readAll());
            if(!result.error.isEmpty()) return status(QString(name)+": "+result.error+". No settings applied.");
            for(auto it=result.values.cbegin();it!=result.values.cend();++it) pending.insert(it.key(),it.value());
            omitted.append(result.omitted);++files;
        }
        if(!files) return status("No rekordbox MY SETTINGS files found on this USB.");
        for(int deck=1;deck<=2;++deck) for(const auto& key:{"master_tempo","tempo_range"})
            if(pending.contains(key)) pending.insert(QString(key)+QString::number(deck),pending.value(key));
        QStringList applied;
        for(auto& row:m_rows) if(pending.contains(row.key)) {
            const int index=row.values.indexOf(pending.value(row.key));
            if(index>=0) {choose(row,index,false);applied.append(row.title);}
        }
        if(pending.contains("quantize")) for(int deck=1;deck<=2;++deck) {
            const auto group=QString("[Channel%1]").arg(deck);
            ControlObject::set(ConfigKey(group,"quantize"),pending.value("quantize"));
            m_config->setValue(ConfigKey("[RX3Settings]",QString("quantize%1").arg(deck)),pending.value("quantize"));
        }
        if(pending.contains("quantize")) applied.append("QUANTIZE");
        if(pending.contains("vinyl_mode")) for(int deck=1;deck<=2;++deck) ControlObject::set(ConfigKey(QString("[Channel%1]").arg(deck),"rx3_vinyl_mode"),pending.value("vinyl_mode"));
        if(pending.contains("auto_cue_level")) for(int deck=1;deck<=2;++deck) ControlObject::set(ConfigKey(QString("[Channel%1]").arg(deck),"rx3_auto_cue_level"),pending.value("auto_cue_level"));
        for(const auto& key:{"play_mode","eject_lock"}) if(pending.contains(key)) {
            ensure("[RX3Settings]",key,pending.value(key));m_config->setValue(ConfigKey("[RX3Settings]",key),pending.value(key));
        }
        if(pending.contains("beatjump_size")) for(int deck=1;deck<=2;++deck) ControlObject::set(ConfigKey(QString("[Channel%1]").arg(deck),"beatjump_size"),pending.value("beatjump_size"));
        if(pending.contains("waveform_divisions") && m_effects) {
            WaveformWidgetFactory::instance()->setOverviewDivisions(qRound(pending.value("waveform_divisions")));
            applied.append("WAVEFORM DIVISIONS");
        }
        if(pending.contains("talkover_level") && ControlObject::exists(ConfigKey("[Master]","rx3_talkover_level"))) {
            ControlObject::set(ConfigKey("[Master]","rx3_talkover_level"),pending.value("talkover_level"));applied.append("TALK OVER LEVEL");
        }
        if(pending.contains("mic_low_cut")) {
            for(int mic=1;mic<=2;++mic) {
                const auto key=ConfigKey(QString("[Microphone%1]").arg(mic),"rx3_low_cut");
                if(ControlObject::exists(key)) ControlObject::set(key,pending.value("mic_low_cut"));
            }
            applied.append("MIC LOW CUT");
        }
        if(pending.contains("sync")) for(int deck=1;deck<=2;++deck) ControlObject::set(ConfigKey(QString("[Channel%1]").arg(deck),"sync_enabled"),pending.value("sync"));
        omitted.removeDuplicates();m_config->save();refresh();
        return status(QString("MY SETTINGS loaded — %1. Not applied: %2.").arg(applied.join(", "),omitted.join(", ")));
    }
    void setWaveformColor(int color) {
        for(auto& row:m_rows) if(row.key=="waveform_color") {
            choose(row,qBound(0,color,2));refresh();return;
        }
    }
    // UTILITY and SHORTCUT use the same setting owners and apply path.
    double utilityValue(const QString& key) const {
        if(key=="auto_cue_level") {
            const double value=ControlObject::get(ConfigKey("[Channel1]","rx3_auto_cue_level"));
            return qAbs(value-ControlObject::get(ConfigKey("[Channel2]","rx3_auto_cue_level")))<1e-6?value:-999;
        }
        if(key=="waveform_current_position") {
            const auto* factory=WaveformWidgetFactory::instance();if(!factory) return -999;
            const double value=factory->getPlayMarkerPosition();
            return qAbs(value-0.25)<1e-6?0:qAbs(value-0.5)<1e-6?1:-999;
        }
        if(key=="waveform_divisions") {
            const auto* factory=WaveformWidgetFactory::instance();return factory?factory->getOverviewDivisions():-999;
        }
        for(const auto& row:m_rows) if(row.key==key) return read(row);
        return ControlObject::get(ConfigKey("[RX3Settings]",key));
    }
    bool utilityAvailable(const QString& key) const {
        if(key=="load_lock" || key=="needle_lock" || key=="play_mode") return true;
        if(key=="waveform_current_position" || key=="waveform_divisions") return m_effects && WaveformWidgetFactory::instance();
        if(key=="eq_mode") {
            if(!m_effects || !m_effects->getBackendManager()->getManifestFromUniqueId("org.mixxx.effects.bessel4lvmixeq") ||
                    !m_effects->getBackendManager()->getManifestFromUniqueId("org.mixxx.effects.biquadfullkilleq")) return false;
            for(int deck=1;deck<=2;++deck) {
                const auto chain=m_effects->getEqualizerEffectChain(QString("[Channel%1]").arg(deck));
                if(!chain || !chain->getEffectSlot(0)) return false;
            }
            return true;
        }
        if(key=="headphones") return ControlObject::exists(ConfigKey("[Master]","headSplit"));
        const QMap<QString,QString> controls{{"auto_cue_level","rx3_auto_cue_level"},
                {"quantize_beat","rx3_quantize_beats"},{"hotcue_autoload","rx3_hotcue_autoload"},
                {"slip_flashing","slip_flashing"},{"channel_curve","channel_fader_curve"}};
        if(!controls.contains(key)) return false;
        for(int deck=1;deck<=2;++deck) if(!ControlObject::exists(ConfigKey(QString("[Channel%1]").arg(deck),controls.value(key)))) return false;
        return true;
    }
    bool setUtilityValue(const QString& key,double value) {
        if(!utilityAvailable(key)) return false;
        if(key=="auto_cue_level") {
            const QList<double> values{-78,-72,-66,-60,-54,-48,-42,-36,0};
            if(!values.contains(value)) return false;
            for(int deck=1;deck<=2;++deck) ControlObject::set(ConfigKey(QString("[Channel%1]").arg(deck),"rx3_auto_cue_level"),value);
            m_config->save();return true;
        }
        if(key=="play_mode") {
            if(value!=0 && value!=1) return false;
            ControlObject::set(ConfigKey("[RX3Settings]",key),value);
            m_config->setValue(ConfigKey("[RX3Settings]",key),value);m_config->save();return true;
        }
        if(key=="waveform_current_position") {
            if(value!=0 && value!=1) return false;
            WaveformWidgetFactory::instance()->setPlayMarkerPosition(value==0?0.25:0.5);m_config->save();return true;
        }
        if(key=="waveform_divisions") {
            if(value!=0 && value!=1) return false;
            WaveformWidgetFactory::instance()->setOverviewDivisions(qRound(value));m_config->save();return true;
        }
        for(auto& row:m_rows) if(row.key==key) {
            const int index=row.values.indexOf(value);if(index<0) return false;
            choose(row,index);refresh();return true;
        }
        return false;
    }
    QString saveSettings() {
        const auto root=qApp->property("rx3SettingsUsbRoot").toString();
        QMap<QString,double> values;
        for(const auto& row:m_rows) if(!row.values.isEmpty()) values.insert(row.key,read(row));
        const QString deck="[Channel1]";
        for(const auto& key:{"quantize","rx3_vinyl_mode","rx3_auto_cue_level","rx3_auto_cue"})
            values.insert(QString(key).startsWith("rx3_")?QString(key).mid(4):QString(key),ControlObject::get(ConfigKey(deck,key)));
        values.insert("master_tempo",ControlObject::get(ConfigKey(deck,"keylock")));
        values.insert("tempo_range",ControlObject::get(ConfigKey(deck,"rateRange")));
        values.insert("sync",ControlObject::get(ConfigKey(deck,"sync_enabled")));
        values.insert("beatjump_size",ControlObject::get(ConfigKey(deck,"beatjump_size")));
        if(ControlObject::exists(ConfigKey("[Master]","rx3_talkover_level"))) values.insert("talkover_level",ControlObject::get(ConfigKey("[Master]","rx3_talkover_level")));
        if(ControlObject::exists(ConfigKey("[Microphone1]","rx3_low_cut"))) values.insert("mic_low_cut",ControlObject::get(ConfigKey("[Microphone1]","rx3_low_cut")));
        for(const auto& key:{"play_mode","eject_lock"}) if(ControlObject::exists(ConfigKey("[RX3Settings]",key))) values.insert(key,ControlObject::get(ConfigKey("[RX3Settings]",key)));
        if(m_effects) values.insert("waveform_divisions",WaveformWidgetFactory::instance()->getOverviewDivisions());
        if(m_savingSettings) return status("MY SETTINGS save is already in progress.");
        m_savingSettings=true;
        auto* watcher=new QFutureWatcher<QString>(this);
        connect(watcher,&QFutureWatcher<QString>::finished,this,[this,watcher] {
            m_savingSettings=false;status(watcher->result());watcher->deleteLater();refresh();
        });
        watcher->setFuture(QtConcurrent::run([root,values] {return rx3::saveUsbMySettings(root,values);}));
        refresh();return status("Saving MY SETTINGS to USB…");
    }
  protected:
    bool eventFilter(QObject* object,QEvent* event) override {
        if(object==parentWidget() && (event->type()==QEvent::Resize ||
                event->type()==QEvent::LayoutRequest)) queuePlacement();
        if(object==m_footer && (event->type()==QEvent::Move ||
                event->type()==QEvent::Resize || event->type()==QEvent::Show)) {
            place();queuePlacement();
        }
        return QFrame::eventFilter(object,event);
    }
  private:
    struct Row {
        QString key,title;QFrame* frame=nullptr;QVector<QPushButton*> buttons;
        QList<double> values;double initial=0;bool stepper=false;
    };
    template<class Layout> void add(Layout* layout,const QString& title,const QString& key,
            QStringList labels,QList<double> values,double initial,bool stepper=false,bool curves=false) {
        Row row;row.key=key;row.title=title;row.values=values;row.initial=initial;row.stepper=stepper;
        row.frame=new QFrame(this);row.frame->setObjectName("ShortcutRow_"+key);
        row.frame->setAttribute(Qt::WA_StyledBackground);row.frame->setProperty("encoderFocus",false);row.frame->setFixedHeight(60);layout->addWidget(row.frame);
        auto* vertical=new QVBoxLayout(row.frame);vertical->setContentsMargins(2,2,2,2);vertical->setSpacing(2);
        auto* caption=new QLabel(title,row.frame);caption->setFixedHeight(16);vertical->addWidget(caption);
        auto* choices=new QHBoxLayout;choices->setSpacing(0);vertical->addLayout(choices);
        ensure("[RX3Settings]",key,m_config->getValue<double>(ConfigKey("[RX3Settings]",key),initial));
        const int rowIndex=int(m_rows.size());
        for(int i=0;i<(stepper?3:labels.size());++i) {
            auto* button=key=="waveform_color"?static_cast<QPushButton*>(new Rx3WaveformColorButton(i,row.frame)):
                    curves?static_cast<QPushButton*>(new Rx3CurveButton(i,key=="crossfader_curve",row.frame)):
                    new QPushButton(stepper?(i==0?"‹":i==2?"›":"3"):labels[i],row.frame);
            button->setObjectName("Shortcut_"+key+"_"+QString::number(i));
            button->setFixedHeight(36);button->setFixedWidth(key.startsWith("tempo_range")?82:stepper||curves?96:88);
            button->setSizePolicy(QSizePolicy::Fixed,QSizePolicy::Fixed);
            if(labels.value(i)=="MONO\nSPLIT") button->setStyleSheet("font-size:13px;padding:0;");
            choices->addWidget(button);row.buttons.append(button);
            connect(button,&QPushButton::clicked,this,[this,rowIndex,i]{
                m_focused=rowIndex;m_editing=true;
                auto& selectedRow=m_rows[rowIndex];
                choose(selectedRow,selectedRow.stepper?std::clamp(selected(selectedRow)+(i==0?-1:i==2?1:0),
                        0,int(selectedRow.values.size())-1):i);refresh();
            });
        }
        choices->addStretch(1);
        m_rows.push_back(row);apply(key,ControlObject::get(ConfigKey("[RX3Settings]",key)));
    }
    void section(QVBoxLayout* layout,const QString& text) {
        auto* label=new QLabel(text,this);label->setFixedHeight(22);label->setProperty("section",true);label->setStyleSheet("border:0;border-bottom:1px solid #a9a9ad;font-size:15px;");layout->addWidget(label);
    }
    void ensure(const QString& group,const QString& key,double initial) {
        if(!ControlObject::exists(ConfigKey(group,key))) m_owners.push_back(
                std::make_unique<ControlObject>(ConfigKey(group,key),false,false,false,initial));
        else if(group=="[RX3Settings]") ControlObject::set(ConfigKey(group,key),initial);
    }
    double read(const Row& row) const {
        if(row.key=="load_lock") return m_config->getValue<LoadWhenDeckPlaying>(kConfigKeyLoadWhenDeckPlaying,
                LoadWhenDeckPlaying::Reject)==LoadWhenDeckPlaying::Reject?1:0;
        if(row.key=="headphones" && ControlObject::exists(ConfigKey("[Master]","headSplit")))
            return ControlObject::get(ConfigKey("[Master]","headSplit"));
        if(row.key=="eq_mode" && m_effects) {
            double value=-999;
            for(int deck=1;deck<=2;++deck) {
                const auto chain=m_effects->getEqualizerEffectChain(QString("[Channel%1]").arg(deck));
                const auto slot=chain?chain->getEffectSlot(0):nullptr;
                const auto manifest=slot?slot->getManifest():nullptr;
                if(!manifest) return -999;
                const double actual=manifest->uniqueId()=="org.mixxx.effects.bessel4lvmixeq"?1:
                        manifest->uniqueId()=="org.mixxx.effects.biquadfullkilleq"?0:-999;
                if(deck==1) value=actual;else if(value!=actual) return -999;
            }
            return value;
        }
        const QMap<QString,QString> live{{"quantize_beat","rx3_quantize_beats"},
                {"hotcue_autoload","rx3_hotcue_autoload"},{"slip_flashing","slip_flashing"},
                {"channel_curve","channel_fader_curve"}};
        if(live.contains(row.key)) {
            const auto item=live.value(row.key);const ConfigKey first("[Channel1]",item),second("[Channel2]",item);
            if(ControlObject::exists(first) && ControlObject::exists(second)) {
                const auto value=ControlObject::get(first);
                return qAbs(value-ControlObject::get(second))<1e-6?value:-999;
            }
        }
        if(row.key.startsWith("master_tempo") || row.key.startsWith("tempo_range")) {
            const auto group=QString("[Channel%1]").arg(row.key.right(1));
            const auto key=row.key.startsWith("master_tempo")?"keylock":"rateRange";
            if(ControlObject::exists(ConfigKey(group,key))) return ControlObject::get(ConfigKey(group,key));
        }
        return ControlObject::get(ConfigKey("[RX3Settings]",row.key));
    }
    int selected(const Row& row) const {
        const auto value=read(row);
        for(int i=0;i<row.values.size();++i) if(qAbs(value-row.values[i])<1e-6) return i;
        return -1;
    }
    void choose(Row& row,int index,bool save=true) {
        const auto value=row.values[index];
        ControlObject::set(ConfigKey("[RX3Settings]",row.key),value);
        m_config->setValue(ConfigKey("[RX3Settings]",row.key),value);
        apply(row.key,value);if(save) m_config->save();
    }
    void apply(const QString& key,double value) {
        auto set=[](const QString& group,const QString& item,double v) {
            if(ControlObject::exists(ConfigKey(group,item))) ControlObject::set(ConfigKey(group,item),v);
        };
        if(key.startsWith("master_tempo")) set(QString("[Channel%1]").arg(key.right(1)),"keylock",value);
        else if(key.startsWith("tempo_range")) set(QString("[Channel%1]").arg(key.right(1)),"rateRange",value);
        else if(key=="slip_flashing") {
            for(int deck=1;deck<=4;++deck) set(QString("[Channel%1]").arg(deck),"slip_flashing",value);
        }
        else if(key=="pitch_bend") {
            for(int deck=1;deck<=2;++deck) set(QString("[Channel%1]").arg(deck),"rx3_pitch_bend",0.5+0.25*(value-1));
        } else if(key=="quantize_beat") {
            for(int deck=1;deck<=2;++deck) set(QString("[Channel%1]").arg(deck),"rx3_quantize_beats",value);
        } else if(key=="hotcue_autoload") {
            set("[RX3Display]","hotcueautoload",value<2?1:0);
            for(int deck=1;deck<=2;++deck) set(QString("[Channel%1]").arg(deck),"rx3_hotcue_autoload",value);
        } else if(key=="time_mode") {
            set("[Controls]","ShowDurationRemaining",value);
            for(int deck=1;deck<=2;++deck) set(QString("[Channel%1]").arg(deck),"rx3_time_remaining",value);
            m_config->setValue(ConfigKey("[Controls]","PositionDisplay"),int(value));
        } else if(key=="auto_cue") {
            set("[RX3Display]","autocue",value);
            for(int deck=1;deck<=2;++deck) set(QString("[Channel%1]").arg(deck),"rx3_auto_cue",value);
            m_config->setValue(ConfigKey("[Controls]","CueRecall"),
                value>0?SeekOnLoadMode::FirstSound:SeekOnLoadMode::Beginning);
        }
        else if(key=="load_lock") m_config->setValue(kConfigKeyLoadWhenDeckPlaying,
                value>0?LoadWhenDeckPlaying::Reject:LoadWhenDeckPlaying::AllowButStopDeck);
        else if(key=="headphones") {
            set("[Master]","headSplit",value);m_config->setValue(ConfigKey("[Master]","headSplit"),value);
        } else if(key=="crossfader_curve") {
            const double curve=value==0?1:value==1?4:1000;
            set("[Mixer Profile]","xFaderCurve",curve);set("[Mixer Profile]","xFaderMode",value==0?1:0);
            m_config->setValue(ConfigKey("[Mixer Profile]","xFaderCurve"),curve);
        } else if(key=="channel_curve") {
            for(int deck=1;deck<=2;++deck) set(QString("[Channel%1]").arg(deck),"channel_fader_curve",value);
        } else if(key=="waveform_color" && m_effects) {
            const WaveformWidgetType::Type types[]{WaveformWidgetType::AllShaderSimpleWaveform,
                    WaveformWidgetType::AllShaderRGBWaveform,WaveformWidgetType::AllShaderRGBStackedWaveform};
            auto* factory=WaveformWidgetFactory::instance();const int index=factory->findHandleIndexFromType(types[qBound(0,qRound(value),2)]);
            if(index>=0 && factory->getType()!=types[qBound(0,qRound(value),2)]) factory->setWidgetTypeFromHandle(index);
        } else if(key=="eq_mode" && m_effects) {
            const auto manifest=m_effects->getBackendManager()->getManifestFromUniqueId(value>0?
                    "org.mixxx.effects.bessel4lvmixeq":"org.mixxx.effects.biquadfullkilleq");
            if(manifest) for(int deck=1;deck<=2;++deck) {
                const auto chain=m_effects->getEqualizerEffectChain(QString("[Channel%1]").arg(deck));
                if(chain && chain->getEffectSlot(0)) {
                    const auto group=QString("[EqualizerRack1_[Channel%1]_Effect1]").arg(deck);
                    std::array<double,3> knobs{};
                    for(int index=0;index<3;++index) {
                        ControlProxy knob(group,QString("parameter%1").arg(index+1),this,ControlFlag::NoAssertIfMissing);
                        knobs[index]=knob.getParameter();
                    }
                    chain->getEffectSlot(0)->loadEffectWithDefaults(manifest);
                    for(int index=0;index<3;++index) {
                        ControlProxy knob(group,QString("parameter%1").arg(index+1),this,ControlFlag::NoAssertIfMissing);
                        knob.setParameter(knobs[index]);
                    }
                }
            }
        }
    }
    QString status(const QString& text) {
        m_status->setToolTip(text);
        m_status->setText(text.size()>200?text.left(197)+"…":text);m_details->setVisible(text.size()>200);return text;
    }
    void queuePlacement() {
        if(m_placementPending) return;
        m_placementPending=true;
        QTimer::singleShot(0,this,[this]{m_placementPending=false;if(isVisible()) place();});
    }
    void place() {
        auto* canvas=parentWidget();
        if(!m_footer) {
            m_footer=canvas->findChild<QWidget*>("RX3LibraryDecks");
            if(m_footer) m_footer->installEventFilter(this);
        }
        const double scale=canvas->height()/800.0;
        const int top=qRound(48*scale);
        int bottom=canvas->height()-qRound(94*scale);
        // Leave a small clear rail above the same live SOURCE/BROWSE footer.
        // The panel must not paint over its deck captions, marks or top borders.
        // The layout settles after selecting the browser page and after scaling.
        if(m_footer && m_footer->isVisibleTo(canvas)) {
            const int footerTop=m_footer->mapTo(canvas,QPoint(0,0)).y();
            if(footerTop>top) bottom=footerTop-qMax(2,qRound(8*scale));
        }
        setGeometry(0,top,canvas->width(),qMax(1,bottom-top));
    }
    void refresh() {
        const auto root=qApp->property("rx3SettingsUsbRoot").toString();
        m_source->setText(root.isEmpty()?"SOURCE — SELECT USB":QString("▣  %1").arg(qApp->property("rx3SettingsUsbName").toString()));
        m_deviceName->setText(root.isEmpty()?QString():qApp->property("rx3SettingsUsbDeviceName").toString());
        bool playing=false;for(int deck=1;deck<=2;++deck) playing|=ControlObject::get(ConfigKey(QString("[Channel%1]").arg(deck),"play"))>0;
        m_load->setEnabled(!m_savingSettings && !root.isEmpty() && QDir(root).exists() && !playing);
        for(int i=0;i<int(m_rows.size());++i) {
            auto& row=m_rows[i];
            row.frame->setProperty("encoderFocus",row.frame==m_rows[m_focused].frame);
            row.frame->style()->unpolish(row.frame);row.frame->style()->polish(row.frame);row.frame->update();
            if(row.key=="usb_save") row.buttons.first()->setEnabled(!m_savingSettings && !root.isEmpty() && QDir(root).exists());
            if(row.values.isEmpty()) continue;
            const int index=selected(row);
            for(int j=0;j<row.buttons.size();++j) {
                auto* button=row.buttons[j];button->setProperty("chosen",row.stepper?j==1:j==index);
                if(row.stepper && j==1) button->setText(index>=0?QString::number(row.values[index]):QString("MIXED"));
                button->style()->unpolish(button);button->style()->polish(button);button->update();
            }
        }
    }
    QPointer<QWidget> m_footer;bool m_placementPending=false;
    UserSettingsPointer m_config;EffectsManager* m_effects;
    std::vector<std::unique_ptr<ControlObject>> m_owners;
    std::vector<Row> m_rows;int m_focused=0;bool m_editing=false;
    bool m_presenting=false;double m_previousTab=0;
    bool m_savingSettings=false;
    QLabel* m_source=nullptr;QLabel* m_deviceName=nullptr;QLabel* m_status=nullptr;QPushButton* m_load=nullptr;QPushButton* m_details=nullptr;
};
