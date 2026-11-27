#pragma once
#include "util/rx3usbstorage.h"

#include <QCryptographicHash>

inline QString WRx3Browser::tagIdentity() const {
    const auto current=catalog();if(!current) return {};
    return m_backend->rekordboxFeature()->sessionIdentityForRoot(m_currentRoot);
}
// The shared legacy "tools" command remains an alias for the unified menu.
inline void WRx3Browser::showTools() {
    showUtility();
}
inline void WRx3Browser::openUtilityTools(QString title,std::function<void()> open) {
    m_pages->setCurrentWidget(m_tools);m_sourceLabel->hide();
    m_breadcrumb->setText("UTILITY / "+title);
    m_tools->showMenu(title,{},[this]{showUtility();});
    if(open) open();
}
inline void WRx3Browser::toolTracks(const QList<quint32>& ids,const QString& name) {
    if(!catalog() || !m_backend->rekordboxFeature()->showTrackIds(m_currentRoot,ids,name)) {
        m_tools->message("USB unavailable. Select a connected source.");return;
    }
    if(m_toolPreview) m_toolPreview->cancel();
    m_pages->setCurrentIndex(0);m_selectedCategory=name;
    showTrackList(BrowserLevel::Categories);m_breadcrumb->setText(name);
}
inline void WRx3Browser::showTagTools() {
    m_tools->showMenu("TAG LIST",{
        toolAction("ADD / REMOVE SELECTED TRACK",[this]{
            const auto key=tagIdentity();
            if(key.isEmpty() || !m_toolTrack || m_toolTrack->getSourceBinding().sourceType()!=mixxx::SourceType::RekordboxUsb) {
                m_tools->message("Select an exported track on this USB first.");return;
            }
            const auto& binding=m_toolTrack->getSourceBinding();
            if(binding.sessionIdentifier().uuid().toString()!=key) {m_tools->message("Selected track belongs to a different USB session.");return;}
            const bool changed=m_tagLists[key].toggle(binding.rekordboxId());
            m_tools->message(changed?QString("TAG LIST: %1 / 100 tracks").arg(m_tagLists[key].ids().size()):"TAG LIST is full (100 tracks).");}),
        toolAction("OPEN TAG LIST",[this]{toolTracks(m_tagLists.value(tagIdentity()).ids(),"TAG LIST");}),
        toolAction("CREATE PLAYLIST ON USB",[this]{saveTagPlaylist();}),
        toolAction("CLEAR TAG LIST",[this]{m_tagLists[tagIdentity()].clear();m_tools->message("TAG LIST cleared.");})
    },[this]{showTools();});
}
inline void WRx3Browser::saveTagPlaylist() {
    if(!catalog()) {m_tools->message("USB unavailable.");return;}
    const auto ids=m_tagLists.value(tagIdentity()).ids();
    if(ids.isEmpty()) {m_tools->message("TAG LIST is empty.");return;}
    const auto name=QString("TAG LIST %1").arg(QDateTime::currentDateTime().toString("yyyy-MM-dd HH-mm-ss"));
    m_tools->message("Saving playlist to USB…");
    QPointer<WRx3Browser> guard(this);
    m_backend->rekordboxFeature()->saveList(m_currentRoot,name,ids,false,[guard,name](QString error){
        if(guard) guard->m_tools->message(error.isEmpty()?"Playlist saved: "+name:error);
    });
}
inline void WRx3Browser::showBankTools() {
    std::vector<ToolAction> actions;
    const auto bankRoot=QString::fromLatin1(QCryptographicHash::hash(m_currentRoot.toUtf8(),QCryptographicHash::Sha256).toHex());
    for(int slot=1;slot<=4;++slot) {
        const auto key=ConfigKey("[RX3PlaylistBank]",bankRoot+QString::number(slot));
        const auto nameKey=ConfigKey(key.group,key.item+"Name");
        actions.push_back(toolAction(QString("BANK %1 — OPEN").arg(slot),[this,key,nameKey]{
            if(!m_config || !catalog()) {m_tools->message("Select a USB first.");return;}
            const auto playlist=catalog()->findPlaylist(m_config->getValueString(key).toUInt());
            if(!playlist || playlist->isFolder || playlist->name!=m_config->getValueString(nameKey)) {m_tools->message("This bank is empty or its playlist is unavailable.");return;}
            toolTracks(playlist->trackIds,playlist->name);
        }));
        actions.push_back(toolAction(QString("BANK %1 — ASSIGN SELECTED PLAYLIST").arg(slot),[this,key,nameKey,slot]{
            if(!m_config || !catalog()) {m_tools->message("Select a USB playlist first.");return;}
            const auto playlist=catalog()->findPlaylist(m_toolPlaylist);
            if(!playlist || playlist->isFolder) {m_tools->message("Open PLAYLIST and select a playlist before opening UTILITY.");return;}
            m_config->setValue(key,QString::number(playlist->rekordboxId));m_config->setValue(nameKey,playlist->name);m_config->save();
            m_tools->message(QString("BANK %1: %2").arg(slot).arg(playlist->name));
        }));
    }
    m_tools->showMenu("PLAYLIST BANK",std::move(actions),[this]{showTools();});
}
inline void WRx3Browser::showFilterTools() {
    if(m_toolTrack) {m_filter.referenceBpm=m_toolTrack->getBpm();m_filter.referenceKey=m_toolTrack->getKeyText();}
    m_tools->showMenu("TRACK FILTER",{
        {[this]() -> QString {return QString("BPM RANGE: %1").arg(m_filter.tempoTolerance==0?"OFF":QString("±%1% around %2").arg(m_filter.tempoTolerance*100).arg(m_filter.referenceBpm,0,'f',2));},{},[this](int delta){
            const QList<double> values{0,0.03,0.06,0.10};const int index=values.indexOf(m_filter.tempoTolerance);
            m_filter.tempoTolerance=values[qBound(0,index+delta,3)];}},
        {[this]() -> QString {return "KEY: "+QStringList{"OFF","COMPATIBLE","EXACT"}[m_filter.keyMode]+" "+m_filter.referenceKey;},{},[this](int delta){m_filter.keyMode=qBound(0,m_filter.keyMode+delta,2);}},
        {[this]() -> QString {return QString("MINIMUM RATING: %1").arg(m_filter.minimumRating);},{},[this](int delta){m_filter.minimumRating=qBound(0,m_filter.minimumRating+delta,5);}},
        {[this]() -> QString {return QString("COLOR: %1").arg(m_filter.color==0?"ANY":QString::number(m_filter.color));},{},[this](int delta){m_filter.color=qBound(0,m_filter.color+delta,8);}},
        toolAction("APPLY FILTER",[this]{if(catalog()) toolTracks(m_filter.apply(catalog()->tracks()),"TRACK FILTER");else m_tools->message("Select a USB first.");}),
        toolAction("RESET FILTER",[this]{m_filter={};m_tools->refresh();})
    },[this]{showTools();});
}
inline void WRx3Browser::showMemoryTools(int deck) {
    const auto group=QString("[Channel%1]").arg(deck);
    std::vector<ToolAction> actions;
    for(const auto& item:QList<QPair<QString,QString>>{{"PREVIOUS CUE / LOOP","rx3_memory_prev"},{"NEXT CUE / LOOP","rx3_memory_next"},
            {"MEMORY — STORE CUE / LOOP","rx3_memory_store"},{"DELETE RECALLED MEMORY","rx3_memory_delete"},{"ACTIVE LOOP — TOGGLE","rx3_memory_active"}})
        actions.push_back(toolAction(item.first,[group,key=item.second]{ControlObject::set(ConfigKey(group,key),1);ControlObject::set(ConfigKey(group,key),0);}));
    actions.push_back(toolAction("SAVE CUES / LOOPS / GRID TO USB",[this,group]{
        const auto track=PlayerInfo::instance().getTrackInfo(group);
        if(!track || !track->isSourceAvailableForPlayback()) {m_tools->message("Load an available USB track first.");return;}
        QString sourceRoot;
        if(!m_backend->rekordboxFeature()->infoForLocation(track->getLocation(),&sourceRoot)) {m_tools->message("The loaded USB source is unavailable.");return;}
        QPointer<WRx3Browser> guard(this);m_tools->message("Saving performance data…");
        m_backend->rekordboxFeature()->savePerformance(sourceRoot,track,[guard](QString error){if(guard) guard->m_tools->message(error.isEmpty()?"Cues, loops and beatgrid saved to USB.":error);});
    }));
    m_tools->showMenu(QString("DECK %1 MEMORY CUES / LOOPS").arg(deck),std::move(actions),[this]{showTools();});
}
inline void WRx3Browser::showPreviewTools() {
    if(!m_toolTrack) {m_tools->message("Select a track first.");return;}
    if(!m_toolPreview) {
        m_toolPreview=std::make_unique<rx3::TouchPreview>([this](TrackPointer track){emit m_backend->loadTrackToPlayer(track,"[PreviewDeck1]",false);});
        connect(&PlayerInfo::instance(),&PlayerInfo::trackChanged,this,[this](const QString& group,TrackPointer track,TrackPointer){
            if(group=="[PreviewDeck1]" && m_toolPreview) m_toolPreview->completed(track);
        });
    }
    m_tools->showMenu("HEADPHONE PREVIEW",{
        toolAction("PLAY FROM PREVIEW POSITION",[this]{m_toolPreview->begin(m_toolTrack,PlayerInfo::instance().getTrackInfo("[PreviewDeck1]"),m_previewPosition);}),
        {[this]() -> QString {return QString("POSITION: %1%").arg(qRound(100*m_previewPosition));},{},[this](int delta){m_previewPosition=qBound(0.0,m_previewPosition+delta*0.01,1.0);m_toolPreview->move(m_previewPosition);}},
        toolAction("STOP PREVIEW",[this]{m_toolPreview->cancel();})
    },[this]{m_toolPreview->cancel();showTools();});
}
inline WRx3Browser::ToolAction WRx3Browser::audioValue(QString label,QString group,QString key,QString configuredKey) {
    return {[this,label,group,key,configuredKey]{
        const bool configured=configuredKey.isEmpty() || (ControlObject::exists(ConfigKey(group,configuredKey)) && ControlObject::get(ConfigKey(group,configuredKey))>0);
        if(!configured) return QString(label+": OUTPUT / INPUT UNAVAILABLE");
        const bool exists=ControlObject::exists(ConfigKey(group,key));
        if(!exists) return QString(label+": UNAVAILABLE");
        return QString(label+QString(": %1%").arg(qRound(ControlProxy(group,key,this,ControlFlag::NoAssertIfMissing).getParameter()*100)));
    },{},[this,group,key,configuredKey](int delta){
        if(!configuredKey.isEmpty() && (!ControlObject::exists(ConfigKey(group,configuredKey)) || ControlObject::get(ConfigKey(group,configuredKey))<=0)) {m_tools->message("Configure this input or output in Sound Hardware first.");return;}
        if(!ControlObject::exists(ConfigKey(group,key))) {m_tools->message("This audio path is unavailable. Configure the interface in Sound Hardware.");return;}
        ControlProxy control(group,key,this,ControlFlag::NoAssertIfMissing);control.setParameter(qBound(0.0,control.getParameter()+delta*0.01,1.0));
    }};
}
inline void WRx3Browser::showAudioTools() {
    std::vector<ToolAction> actions;
    for(int mic=1;mic<=2;++mic) {
        const auto group=QString("[Microphone%1]").arg(mic);
        actions.push_back({[group,mic]() -> QString {return QString("MIC %1: ").arg(mic)+
                    (ControlObject::get(ConfigKey(group,"input_configured"))<=0?"INPUT UNAVAILABLE":ControlObject::get(ConfigKey(group,"talkover"))>0?"ON":"OFF");},
            [this,group]{if(ControlObject::get(ConfigKey(group,"input_configured"))<=0) {m_tools->message("Configure a microphone input on your audio interface first.");return;}
                const auto key=ConfigKey(group,"talkover");ControlObject::set(key,ControlObject::get(key)>0?0:1);},{}});
        actions.push_back(audioValue(QString("MIC %1 GAIN").arg(mic),group,"pregain","input_configured"));
        for(const auto& band: {QString("low"),QString("high")}) {
            const QString key="rx3_eq_"+band;
            actions.push_back({[group,key,mic,band]() -> QString {
                if(!ControlObject::exists(ConfigKey(group,key)) || ControlObject::get(ConfigKey(group,"input_configured"))<=0) return QString("MIC %1 %2: INPUT UNAVAILABLE").arg(mic).arg(band.toUpper());
                return QString("MIC %1 %2: %3 dB").arg(mic).arg(band.toUpper()).arg(ControlObject::get(ConfigKey(group,key)),0,'f',1);
            },{},[this,group,key](int delta){
                if(ControlObject::get(ConfigKey(group,"input_configured"))<=0) {m_tools->message("Configure a microphone input first.");return;}
                if(ControlObject::exists(ConfigKey(group,key))) ControlObject::set(ConfigKey(group,key),qBound(-12.0,ControlObject::get(ConfigKey(group,key))+0.5*delta,12.0));
            }});
        }
        actions.push_back({[group,mic]() -> QString {
                if(!ControlObject::exists(ConfigKey(group,"rx3_low_cut")) || ControlObject::get(ConfigKey(group,"input_configured"))<=0) return QString("MIC %1 LOW CUT (80 Hz): INPUT UNAVAILABLE").arg(mic);
                return QString("MIC %1 LOW CUT (80 Hz): ").arg(mic)+(ControlObject::get(ConfigKey(group,"rx3_low_cut"))>0?"ON":"OFF");},
            [this,group]{
                if(ControlObject::get(ConfigKey(group,"input_configured"))<=0) {m_tools->message("Configure a microphone input first.");return;}
                const auto key=ConfigKey(group,"rx3_low_cut");if(ControlObject::exists(key)) ControlObject::set(key,ControlObject::get(key)>0?0:1);
            },{}});
    }
    for(int deck=1;deck<=2;++deck) {
        const auto group=QString("[Channel%1]").arg(deck);
        actions.push_back(toolAction(QString("DECK %1 EXTERNAL INPUT — TOGGLE").arg(deck),[this,group]{
            if(ControlObject::get(ConfigKey(group,"input_configured"))<=0) {m_tools->message("Configure an external deck input first.");return;}
            const auto key=ConfigKey(group,"passthrough");ControlObject::set(key,ControlObject::get(key)>0?0:1);
        }));
    }
    actions.push_back(toolAction("AUX — ON / OFF",[this]{
        if(ControlObject::get(ConfigKey("[Auxiliary1]","input_configured"))<=0) {m_tools->message("Configure an AUX input first.");return;}
        const auto key=ConfigKey("[Auxiliary1]","main_mix");ControlObject::set(key,ControlObject::get(key)>0?0:1);
    }));
    actions.push_back(audioValue("AUX GAIN","[Auxiliary1]","pregain","input_configured"));
    actions.push_back(audioValue("MASTER LEVEL","[Master]","gain"));
    actions.push_back({[]() -> QString {return "MIC DUCKING: "+QStringList{"OFF","AUTO","MANUAL"}.value(qRound(ControlObject::get(ConfigKey("[Master]","talkoverDucking"))));},{},[](int delta){
        const auto key=ConfigKey("[Master]","talkoverDucking");ControlObject::set(key,qBound(0,qRound(ControlObject::get(key))+delta,2));}});
    actions.push_back(audioValue("CUSTOM DUCKING AMOUNT","[Master]","duckStrength"));
    actions.push_back({[]() -> QString {return QString("TALK OVER PROFILE: ")+(ControlObject::get(ConfigKey("[Master]","rx3_talkover_enabled"))>0?"RX3 NORMAL (-10 dB)":"CUSTOM");},[]{
        const auto key=ConfigKey("[Master]","rx3_talkover_enabled");if(ControlObject::exists(key)) ControlObject::set(key,ControlObject::get(key)>0?0:1);
    },{}});
    actions.push_back({[]() -> QString {return QString("RX3 NORMAL TALK OVER LEVEL: %1 dB").arg(qRound(ControlObject::get(ConfigKey("[Master]","rx3_talkover_level"))));},{},[](int delta){
        const auto key=ConfigKey("[Master]","rx3_talkover_level");if(ControlObject::exists(key)) ControlObject::set(key,qBound(-24.0,ControlObject::get(key)+delta*6.0,-6.0));
    }});
    actions.push_back(audioValue("HEADPHONE LEVEL","[Master]","headGain","headEnabled"));
    actions.push_back(audioValue("HEADPHONE CUE / MASTER","[Master]","headMix","headEnabled"));
    actions.push_back(audioValue("BOOTH LEVEL","[Master]","booth_gain","booth_enabled"));
    actions.push_back(toolAction("HEADPHONE MONO SPLIT — TOGGLE",[]{const auto key=ConfigKey("[Master]","headSplit");ControlObject::set(key,ControlObject::get(key)>0?0:1);}));
    m_tools->showMenu("MIXER / MIC / AUX / BOOTH",std::move(actions),[this]{showTools();});
}
inline void WRx3Browser::showRecordingTools() {
    m_tools->showMenu("USB RECORDING",{
        toolAction("START RECORDING TO SELECTED USB",[this]{
            if(!m_config || !catalog()) {m_tools->message("Select a connected USB in SOURCE first.");return;}
            if(ControlObject::get(ConfigKey("[Recording]","status"))>0) {m_tools->message("A recording is already active.");return;}
            rx3::UsbStorageInfo storage(m_currentRoot);storage.refresh();
            if(!storage.isReady() || storage.isReadOnly() || storage.bytesAvailable()<=1024LL*1024*1024) {m_tools->message("USB unavailable, read-only or less than 1 GiB free.");return;}
            const auto directory=QDir(m_currentRoot).filePath("PIONEER/REC");
            if(!QDir().mkpath(directory) || QFileInfo(directory).isSymLink() || !QFileInfo(directory).canonicalFilePath().startsWith(QFileInfo(m_currentRoot).canonicalFilePath()+"/")) {m_tools->message("Unable to create the USB recording folder.");return;}
            m_recordingRoot=m_currentRoot;m_recordingDevice=QString::fromLatin1(storage.device().toHex());
            m_config->setValue(ConfigKey("[Recording]","Directory"),directory);m_config->setValue(ConfigKey("[Recording]","Encoding"),QString("WAV"));
            m_config->setValue(ConfigKey("[Recording]","FileSize"),QString("4 GB"));m_config->save();
            ControlObject::set(ConfigKey("[Recording]","rx3_start"),1);ControlObject::set(ConfigKey("[Recording]","rx3_start"),0);
            m_tools->message("Recording requested — USB WAV, automatic 4 GB splits.");
        }),
        toolAction("STOP RECORDING",[this]{if(ControlObject::get(ConfigKey("[Recording]","status"))>0) {ControlObject::set(ConfigKey("[Recording]","rx3_stop"),1);ControlObject::set(ConfigKey("[Recording]","rx3_stop"),0);}m_tools->message("Recording stopped.");}),
        toolAction("SPLIT — START NEXT RECORDING FILE",[]{ControlObject::set(ConfigKey("[Recording]","rx3_split"),1);ControlObject::set(ConfigKey("[Recording]","rx3_split"),0);}),
        toolAction("OPEN USB RECORDINGS",[this]{
            if(!catalog()) {m_tools->message("Select a USB first.");return;}
            m_pages->setCurrentIndex(0);m_selectedCategory="REC";showFolder(QDir(m_currentRoot).filePath("PIONEER/REC"));}),
        {[this]{rx3::UsbStorageInfo storage(m_recordingRoot.isEmpty()?m_currentRoot:m_recordingRoot);const auto seconds=qRound(ControlObject::get(ConfigKey("[Recording]","rx3_seconds")));return QString("REC: %1 · %2:%3 · FREE: %4 MiB").arg(ControlObject::get(ConfigKey("[Recording]","status"))>0?"ON":"OFF").arg(seconds/60,2,10,QChar('0')).arg(seconds%60,2,10,QChar('0')).arg(storage.bytesAvailable()/1024/1024);},{},{}}
    },[this]{showTools();});
}
inline void WRx3Browser::refreshSessionWork() {
    if(!m_backend) return;
    if(!m_recordingRoot.isEmpty() && ControlObject::get(ConfigKey("[Recording]","status"))>0) {
        rx3::UsbStorageInfo storage(m_recordingRoot);storage.refresh();
        if(!storage.isReady() || QString::fromLatin1(storage.device().toHex())!=m_recordingDevice ||
                !m_backend->rekordboxFeature()->catalogForRoot(m_recordingRoot) || storage.bytesAvailable()<=1024LL*1024*1024) {
            ControlObject::set(ConfigKey("[Recording]","rx3_stop"),1);ControlObject::set(ConfigKey("[Recording]","rx3_stop"),0);
            m_recordingRoot.clear();m_tools->message("Recording stopped: USB unavailable or full.");
        }
    }
    if(m_pages->currentWidget()==m_tools) m_tools->refresh();
    QHash<QString,QList<quint32>> histories;QHash<QString,QString> roots;
    for(const auto& track:m_backend->browserPlaybackState()->playedTracks()) {
        const auto& binding=track->getSourceBinding();
        if(binding.sourceType()!=mixxx::SourceType::RekordboxUsb || !track->isSourceAvailableForPlayback()) continue;
        const auto identity=binding.sessionIdentifier().uuid().toString();
        QString root;
        if(!m_backend->rekordboxFeature()->infoForLocation(track->getLocation(),&root)) continue;
        roots[identity]=root;histories[identity].append(binding.rekordboxId());
    }
    for(auto it=histories.cbegin();it!=histories.cend();++it) {
        if(it->size()<=m_historySaved.value(it.key()) || m_historyBusy.contains(it.key())) continue;
        const auto key=it.key();const int count=it->size();m_historyBusy.insert(key);QPointer<WRx3Browser> guard(this);
        m_backend->rekordboxFeature()->saveList(roots.value(key),m_historyName,*it,true,[guard,key,count](QString error){
            if(!guard) return;guard->m_historyBusy.remove(key);
            if(error.isEmpty()) guard->m_historySaved.insert(key,count);
            else guard->m_tools->message("USB HISTORY: "+error);
        });
    }
}

inline void WRx3Browser::showPlaybackTools() {
    std::vector<ToolAction> actions;
    for(int deck=1;deck<=2;++deck) {
        const auto group=QString("[Channel%1]").arg(deck);
        actions.push_back({[group,deck]() -> QString {return QString("DECK %1 AUTO CUE: %2").arg(deck).arg(ControlObject::get(ConfigKey(group,"rx3_auto_cue"))>0?"ON":"OFF");},[group]{const auto key=ConfigKey(group,"rx3_auto_cue");ControlObject::set(key,ControlObject::get(key)>0?0:1);},{}});
        actions.push_back({[group,deck]() -> QString {const auto value=ControlObject::get(ConfigKey(group,"rx3_auto_cue_level"));return QString("DECK %1 AUTO CUE LEVEL: %2").arg(deck).arg(value==0?QString("MEMORY"):QString(QString::number(value)+" dB"));},{},[group](int delta){const QList<double> values{-36,-42,-48,-54,-60,-66,-72,-78,0};const auto key=ConfigKey(group,"rx3_auto_cue_level");ControlObject::set(key,values[qBound(0,values.indexOf(ControlObject::get(key))+delta,8)]);}});
    }
    for(const auto& item:QList<QPair<QString,QString>>{{"play_mode","PLAY MODE"},{"eject_lock","EJECT LOCK"}}) {
        const auto key=ConfigKey("[RX3Settings]",item.first);const auto title=item.second;
        actions.push_back({[key,title]() -> QString {const auto value=ControlObject::get(key);return title+": "+(key.item=="play_mode"?(value>0?"SINGLE":"CONTINUE"):(value>0?"LOCK":"UNLOCK"));},
            [this,key]{if(!ControlObject::exists(key)) {m_tools->message("Open SHORTCUT to initialize playback settings.");return;}
                const double value=ControlObject::get(key)>0?0:1;ControlObject::set(key,value);if(m_config) {m_config->setValue(key,value);m_config->save();}},{}});
    }
    m_tools->showMenu("PLAYBACK OPTIONS",std::move(actions),[this]{showTools();});
}
inline void WRx3Browser::advanceContinuous(int deck) {
    const auto playMode=ConfigKey("[RX3Settings]","play_mode");
    if(!ControlObject::exists(playMode) || ControlObject::get(playMode)>0 || !m_backend) return;
    const auto group=QString("[Channel%1]").arg(deck);const auto track=PlayerInfo::instance().getTrackInfo(group);
    if(!track || !track->isSourceAvailableForPlayback() || ControlObject::get(ConfigKey(group,"cue_preview"))>0) return;
    const auto origin=m_playbackOrigins.constFind(group);if(origin==m_playbackOrigins.cend()) return;
    const auto& binding=track->getSourceBinding();const int index=origin->ids.indexOf(binding.rekordboxId());
    if(index<0 || index+1>=origin->ids.size()) return;
    const auto next=m_backend->rekordboxFeature()->temporaryTrackForRoot(origin->root,origin->ids[index+1]);
    if(next) {const auto saved=*origin;m_origins.insert(next->getLocation(),saved);m_continuousLoads.insert(group+next->getLocation());emit m_backend->loadTrackToPlayer(next,group,ControlObject::get(ConfigKey(group,"rx3_auto_cue"))<=0);}
}

inline void WRx3Browser::showBeatFxTools() {
    auto* widget=window()->findChild<QWidget*>("RX3BeatFxControls");
    auto* fx=dynamic_cast<WRx3BeatFx*>(widget);
    if(!fx) {m_tools->message("Beat FX controls are unavailable in this skin.");return;}
    QPointer<QWidget> guard(fx);
    auto panel=[guard]() -> WRx3BeatFx* {return dynamic_cast<WRx3BeatFx*>(guard.data());};
    auto* effects=fx->effectsManager();
    const auto manifests=rx3BeatFxManifests(effects->getBackendManager());
    const auto chain=effects->getEffectChain(WRx3BeatFx::unitGroup());
    const auto slot=chain->getEffectSlot(0);
    std::vector<ToolAction> actions;
    actions.push_back({[slot]() -> QString {return "EFFECT: "+(slot->getManifest()?slot->getManifest()->displayName().toUpper():QString("NONE"));},{},[panel,slot,manifests](int delta) {
        int index=-1;for(int i=0;i<manifests.size();++i) if(slot->getManifest() && manifests[i]->uniqueId()==slot->getManifest()->uniqueId()) index=i;
        if(auto* fx=panel();fx && !manifests.isEmpty()) fx->selectEffect(manifests[qBound(0,index+delta,int(manifests.size())-1)],false);
    }});
    actions.push_back({[]() -> QString {return QString("ON / OFF: %1").arg(ControlObject::get(ConfigKey(WRx3BeatFx::unitGroup(),"enabled"))>0?"ON":"OFF");},[panel]{if(auto* fx=panel()) fx->setActive(ControlObject::get(ConfigKey(WRx3BeatFx::unitGroup(),"enabled"))<=0);},{}});
    actions.push_back({[panel]() -> QString {auto* fx=panel();return QString("LEVEL / DEPTH: %1%").arg(fx?qRound(fx->amount()*100):0);},{},[panel](int delta){if(auto* fx=panel()) fx->setAmount(fx->amount()+delta*0.05);}});
    actions.push_back({[]() -> QString {return QString("BPM MODE: %1").arg(ControlObject::get(ConfigKey("[RX3BeatFx]","bpm_mode"))>0?"MANUAL / TAP":"AUTO");},[]{const auto key=ConfigKey("[RX3BeatFx]","bpm_mode");ControlObject::set(key,ControlObject::get(key)>0?0:1);},{}});
    actions.push_back({[]() -> QString {return QString("MANUAL BPM: %1").arg(ControlObject::get(ConfigKey("[RX3BeatFx]","bpm_manual")),0,'f',1);},{},[](int delta){ControlObject::set(ConfigKey("[RX3BeatFx]","bpm_mode"),1);const auto key=ConfigKey("[RX3BeatFx]","bpm_manual");ControlObject::set(key,qBound(40.0,ControlObject::get(key)+delta,300.0));}});
    auto tap=std::make_shared<QElapsedTimer>();
    actions.push_back(toolAction("TAP BPM",[tap]{if(tap->isValid()) {const auto elapsed=tap->elapsed();if(elapsed>=200 && elapsed<=1500) {ControlObject::set(ConfigKey("[RX3BeatFx]","bpm_manual"),60000.0/elapsed);ControlObject::set(ConfigKey("[RX3BeatFx]","bpm_mode"),1);}}tap->restart();}));
    const QList<QPair<QString,QString>> routes{{"MASTER","[Master]"},{"DECK 1","[Channel1]"},{"DECK 2","[Channel2]"},{"MIC 1","[Microphone]"},{"MIC 2","[Microphone2]"},{"AUX","[Auxiliary1]"}};
    actions.push_back({[routes]() -> QString {QStringList names;for(const auto& route:routes) if(ControlObject::get(ConfigKey(WRx3BeatFx::unitGroup(),"group_"+route.second+"_enable"))>0) names.append(route.first);return "CH SELECT: "+(names.isEmpty()?QString("NONE"):names.join(" + "));},{},[routes,chain](int delta){
        int index=-1;for(int i=0;i<routes.size();++i) if(ControlObject::get(ConfigKey(WRx3BeatFx::unitGroup(),"group_"+routes[i].second+"_enable"))>0) {index=i;break;}
        const int next=qBound(0,index+delta,int(routes.size())-1);
        const auto active=chain->getActiveChannels();for(const auto& channel:active) ControlObject::set(ConfigKey(WRx3BeatFx::unitGroup(),"group_"+channel.name()+"_enable"),0);
        ControlObject::set(ConfigKey(WRx3BeatFx::unitGroup(),"group_"+routes[next].second+"_enable"),1);
    }});
    actions.push_back({[panel]() -> QString {auto* fx=panel();return QString("X-PAD: %1 — PRESS TO HOLD / RELEASE").arg(fx?fx->padValueText():QString("UNAVAILABLE"));},{},[panel](int delta){if(auto* fx=panel()) fx->stepPad(delta);},[](bool editing){
        ControlObject::set(ConfigKey("[RX3BeatFx]","xpad_hold"),editing?1:0);
    }});
    for(int bank=0;bank<4;++bank) {
        actions.push_back({[panel,bank,effects]() -> QString {auto* fx=panel();const auto manifest=fx?effects->getBackendManager()->getManifestFromUniqueId(fx->bankId(bank)):EffectManifestPointer();return QString("BANK %1: %2 — PRESS TO RECALL / EDIT CONTROLS BELOW").arg(bank+1).arg(manifest?manifest->displayName().toUpper():QString("EMPTY"));},[this,panel,bank]{if(auto* fx=panel()) {if(fx->bankId(bank).isEmpty()) m_tools->message("Select an effect and use STORE below to assign this bank.");else fx->recallBank(bank);}},{}});
        actions.push_back(toolAction(QString("STORE SELECTED EFFECT IN BANK %1").arg(bank+1),[panel,slot,bank]{if(auto* fx=panel()) fx->registerBank(bank,slot->getManifest());}));
        actions.push_back(toolAction(QString("CLEAR BANK %1").arg(bank+1),[panel,bank]{if(auto* fx=panel()) fx->clearBank(bank);}));
    }
    m_tools->showMenu("BEAT FX",std::move(actions),[this]{showTools();});
}
