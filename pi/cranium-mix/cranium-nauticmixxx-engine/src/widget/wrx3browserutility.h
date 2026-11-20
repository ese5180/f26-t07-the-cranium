#pragma once

#include <QLocale>
#include "version.h"

inline void WRx3Browser::showUtility() {
    if(m_pages->currentWidget()==m_utility) return;
    if(m_utilitySessionActive && m_pages->currentWidget()==m_tools) {
        m_pages->setCurrentWidget(m_utility);m_sourceLabel->hide();
        m_breadcrumb->setText("UTILITY");m_utility->refresh();return;
    }
    m_utilityReturnPage=m_pages->currentIndex();m_utilityReturnFocus=m_focus;
    m_utilityReturnBreadcrumb=m_breadcrumb->text();
    if(m_utilityReturnPage==1) {
        const auto device=sourceDeviceForNavigation();
        if(deviceReady(device)) chooseSource();
        else {m_selectedDevice=QPersistentModelIndex();m_currentRoot.clear();}
    }
    m_toolTrack.reset();m_toolPlaylist=0;
    if(m_level==BrowserLevel::Tracks) if(auto* table=m_library->getCurrentTrackTableView())
        if(auto* tracks=dynamic_cast<TrackModel*>(table->model())) m_toolTrack=tracks->getTrack(table->currentIndex());
    const auto data=selectedTreeIndex().data(SidebarModel::DataRole).toList();
    if(m_level==BrowserLevel::Hierarchy && data.size()>=3) m_toolPlaylist=data[2].toUInt();
    m_utilitySessionActive=true;
    showBrowser();m_keyboard->hide();m_pages->setCurrentWidget(m_utility);
    m_sourceLabel->hide();m_breadcrumb->setText("UTILITY");
    QPointer<WRx3Shortcut> service(settingsService());
    using Setting=WRx3Utility::Setting;
    std::vector<Setting> settings;
    const auto action=[this,&settings](QString category,QString name,std::function<void()> open) {
        Setting setting{category,name,{},[]{return QString("OPEN ›");},{},{},{}};
        setting.execute=[this,name,open]{openUtilityTools(name,open);};
        settings.push_back(std::move(setting));
    };
    const auto shared=[&settings,service](QString category,QString name,QString key,
            QStringList labels,QList<double> values,QString explanation={}) {
        const bool available=service && service->utilityAvailable(key);
        const auto current=[service,key,values]() -> int {
            if(!service) return -1;
            const double value=service->utilityValue(key);
            for(int i=0;i<values.size();++i) if(qAbs(values[i]-value)<1e-6) return i;
            return -1;
        };
        const auto display=[available,current,labels]() -> QString {
            if(!available) return "UNAVAILABLE";
            const int index=current();return index>=0?labels[index]:QString("MIXED / CUSTOM");
        };
        Setting setting{category,name,labels,display,current,{},explanation};
        if(available) setting.apply=[service,key,values](int index) {
            return service && index>=0 && index<values.size() && service->setUtilityValue(key,values[index]);
        };
        else setting.explanation="This setting's software control is unavailable in the current skin.";
        settings.push_back(std::move(setting));
    };
    const auto setupAction = [&settings](QString name, QString command) {
        Setting setting{"SYSTEM", name, {}, [] { return QString("OPEN ›"); }, {}, {}, {}};
        setting.execute = [command] {
            ControlObject::set(ConfigKey("[Cranium]", command), 1);
            ControlObject::set(ConfigKey("[Cranium]", command), 0);
        };
        settings.push_back(std::move(setting));
    };
    setupAction("CONTROLLER SETUP", "open_controllers");
    setupAction("AUDIO OUTPUT SETUP", "open_audio");
    setupAction("SYSTEM / DEVELOPER", "open_preferences");
    shared("DECK","LOAD LOCK","load_lock",{"UNLOCK","LOCK"},{0,1});
    shared("DECK","NEEDLE LOCK","needle_lock",{"UNLOCK","LOCK"},{0,1});
    shared("DECK","QUANTIZE BEAT VALUE (DECK)","quantize_beat",{"1/8","1/4","1/2","1 Beat"},{0.125,0.25,0.5,1});
    shared("DECK","HOT CUE AUTO LOAD","hotcue_autoload",{"OFF","rekordbox SETTING","ON"},{2,1,0});
    shared("DECK","AUTO CUE LEVEL","auto_cue_level",{"-78 dB","-72 dB","-66 dB","-60 dB","-54 dB","-48 dB","-42 dB","-36 dB","MEMORY"},
            {-78,-72,-66,-60,-54,-48,-42,-36,0},"Applies to both decks; MEMORY uses the first stored memory cue.");
    shared("DECK","SLIP FLASHING","slip_flashing",{"OFF","ON"},{0,1});
    shared("DECK","PLAY MODE","play_mode",{"CONTINUE","SINGLE"},{0,1},"REPEAT and ALL REPEAT are not implemented; available modes are CONTINUE and SINGLE.");
    action("DECK","PLAYBACK OPTIONS",[this]{showPlaybackTools();});
    action("DECK","DECK 1 MEMORY CUES / LOOPS",[this]{showMemoryTools(1);});
    action("DECK","DECK 2 MEMORY CUES / LOOPS",[this]{showMemoryTools(2);});
    action("DECK","SHORTCUT / MY SETTINGS",[this]{closeUtility();ControlObject::set(ConfigKey("[RX3Shortcut]","open"),1);ControlObject::set(ConfigKey("[RX3Shortcut]","open"),0);});
    shared("MIXER","EQUALIZER CURVE","eq_mode",{"EQUALIZER","ISOLATOR"},{0,1});
    shared("MIXER","CHANNEL FADER CURVE","channel_curve",{"CURVE1","CURVE2","CURVE3"},{0,1,2});
    shared("MIXER","HEADPHONES MONO SPLIT/STEREO","headphones",{"MONO SPLIT","STEREO"},{1,0});
    action("MIXER","MIXER / MIC / AUX / BOOTH",[this]{showAudioTools();});
    action("EFFECTS","BEAT FX",[this]{showBeatFxTools();});
    action("BROWSER","TAG LIST / TAG TRACK",[this]{showTagTools();});
    action("BROWSER","PLAYLIST BANK",[this]{showBankTools();});
    action("BROWSER","TRACK FILTER",[this]{showFilterTools();});
    action("BROWSER","RELATED KEY",[this]{
        if(!m_toolTrack || !catalog()) {m_tools->message("Select a USB track first.");return;}
        rx3::TrackFilter filter;filter.referenceKey=m_toolTrack->getKeyText();filter.keyMode=1;
        auto ids=filter.apply(catalog()->tracks());ids.removeAll(m_toolTrack->getSourceBinding().rekordboxId());
        toolTracks(ids,"RELATED KEY");});
    action("BROWSER","PREVIEW SELECTED TRACK",[this]{showPreviewTools();});
    action("RECORDING","USB RECORDING",[this]{showRecordingTools();});
    shared("DISPLAY","WAVEFORM CURRENT POSITION","waveform_current_position",{"LEFT","CENTER"},{0,1});
    shared("DISPLAY","WAVEFORM DIVISIONS","waveform_divisions",{"TIME SCALE","PHRASE"},{0,1});
    if(m_config) {
        QStringList locales{"en_US"};
        const QDir directory(m_config->getResourcePath()+"translations/");
        for(const auto& file:directory.entryList({"mixxx_*.qm"},QDir::Files)) {
            const QString code=file.mid(6,file.size()-9);
            if(!locales.contains(code)) locales.push_back(code);
        }
        QStringList names;
        for(const auto& code:locales) names.push_back(QLocale(code).nativeLanguageName()+" ("+code+")");
        const auto language=[this]{const auto code=m_config->getValueString(ConfigKey("[Config]","Locale"));return code.isEmpty()?QString("en_US"):code;};
        const auto current=[language,locales]{return locales.indexOf(language());};
        settings.push_back({"GENERAL","LANGUAGE",names,
                language,current,
                [this,locales](int index){if(index<0 || index>=locales.size()) return false;
                    m_config->setValue(ConfigKey("[Config]","Locale"),locales[index]);m_config->save();return true;},
                "Restart Cranium to apply the language. New profiles default to English."});
    }
    settings.push_back({"GENERAL","VERSION No.",{},[]{return QStringLiteral(NAUTICMIX_VERSION);},{},{},"Cranium application version."});
    m_utility->present(std::move(settings),[this]{closeUtility();});
}
