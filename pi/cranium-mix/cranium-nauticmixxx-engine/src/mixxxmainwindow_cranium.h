#pragma once
#include <QDir>
#include <QFile>
#include <QProcess>
#include <QScreen>
#include <QTimer>
#include <QCoreApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include "controllers/controllermanager.h"
#include "soundio/soundmanager.h"
#include "soundio/craniumaudio.h"

namespace {
bool craniumDeveloperActive() {
    return QFileInfo::exists(qEnvironmentVariable("XDG_RUNTIME_DIR") + "/cranium-developer");
}
QList<SoundDevicePointer> craniumAudioDeviceList(const std::shared_ptr<SoundManager>& sound) {
    QList<SoundDevicePointer> result;
    for(const auto& api:sound->getHostAPIList())result.append(sound->getDeviceList(api,true,false));
    return result;
}
QString craniumAudioDisplayName(const SoundDevicePointer& device) {
    auto name=device->getDisplayName();
    if(name.contains("bcm2835",Qt::CaseInsensitive)||name.contains("raspberry",Qt::CaseInsensitive))
        name=name.contains("HDMI",Qt::CaseInsensitive)?QString("HDMI output"):
                name.contains("headphone",Qt::CaseInsensitive)?QString("Built-in headphones"):QString("Built-in audio");
    return name+" · "+device->getHostAPI();
}
QString craniumAudioId(const SoundDevicePointer& device) {
    const auto& id=device->getDeviceId();
    return device->getHostAPI()+"|"+id.name+"|"+id.alsaHwDevice+
            (id.alsaHwDevice.isEmpty()?"|"+QString::number(id.portAudioIndex):QString());
}
QString craniumUsbStatus() {
#ifdef __LINUX__
    for(const auto& entry:QDir("/sys/bus/usb/devices").entryList(QDir::Dirs|QDir::NoDotAndDotDot)) {
        QFile product("/sys/bus/usb/devices/"+entry+"/product");
        if(product.open(QIODevice::ReadOnly)&&QString::fromUtf8(product.readAll()).contains("FLX4",Qt::CaseInsensitive))
            return "USB controller detected. MIDI connection status is shown below.";
    }
    return "No USB controller detected. Check the USB data cable and controller port.";
#else
    return "USB MIDI connection status";
#endif
}
bool craniumPlaying() {
    for(const auto& family:{qMakePair(QString("num_decks"),QString("[Channel%1]")),
            qMakePair(QString("num_samplers"),QString("[Sampler%1]")),
            qMakePair(QString("num_preview_decks"),QString("[PreviewDeck%1]"))}) {
        const int count=static_cast<int>(ControlObject::get(ConfigKey("[App]",family.first)));
        for(int index=1;index<=count;++index)
            if(ControlObject::toBool(ConfigKey(family.second.arg(index),"play")))return true;
    }
    return ControlObject::toBool(ConfigKey("[AutoDJ]","enabled"));
}
}

void MixxxMainWindow::showCraniumSettings(int page) {
    if(!m_craniumSettings) {
        const auto controller=m_pCoreServices->getControllerManager();
        const auto sound=m_pCoreServices->getSoundManager();
        CraniumSettings::Services services;
        services.controllers=[controller]{return controller->craniumControllerStatus();};
        services.usbStatus=craniumUsbStatus;
        services.enableController=[controller](QString name,bool enabled){emit controller->requestCraniumControllerEnabled(name,enabled);};
        services.refreshControllers=[controller]{emit controller->requestCraniumRefresh();};
        services.playing=craniumPlaying;
        services.deckState=[](int deck){const auto group=QString("[Channel%1]").arg(deck);return QVariantMap{
            {"loaded",ControlObject::get(ConfigKey(group,"track_loaded"))>0},
            {"playing",ControlObject::toBool(ConfigKey(group,"play"))}};};
        services.toggleDeck=[](int deck)->QString{const auto group=QString("[Channel%1]").arg(deck);
            if(ControlObject::get(ConfigKey(group,"track_loaded"))<=0)return QString("Load a track on deck %1 first.").arg(deck);
            ControlObject::set(ConfigKey(group,"play"),ControlObject::toBool(ConfigKey(group,"play"))?0:1);return {};};
        auto scannedDevices=std::make_shared<QVariantList>();auto scanReady=std::make_shared<bool>(false);

        services.developer=craniumDeveloperActive;
        services.audioDevices=[sound,scannedDevices,scanReady](bool refresh){
            if(*scanReady)return *scannedDevices;
            Q_UNUSED(refresh); // Refresh is an independent process; never restart the engine here.
            QVariantList result;
            for(const auto& device:craniumAudioDeviceList(sound)) {
                if(device->getNumOutputChannels()<mixxx::audio::ChannelCount::stereo() || device->getDeviceId().name==kNetworkDeviceInternalName)continue;
                result << QVariantMap{{"id",craniumAudioId(device)},
                        {"name",craniumAudioDisplayName(device)},
                        {"channels",int(device->getNumOutputChannels().value())}};
            }
            return result;
        };
        services.refreshAudio=[this,sound,scannedDevices,scanReady](std::function<void(QVariantList,QString)> complete){
            // Probe separately: Refresh never closes live streams or blocks the UI.
            auto* process=new QProcess(this);auto* deadline=new QTimer(process);deadline->setSingleShot(true);
            auto finished=std::make_shared<bool>(false);
            const auto finish=[process,deadline,finished,complete](QVariantList devices,QString error){
                if(*finished)return;*finished=true;deadline->stop();complete(std::move(devices),std::move(error));
                if(process->state()==QProcess::NotRunning)process->deleteLater();
            };
            connect(process,qOverload<int,QProcess::ExitStatus>(&QProcess::finished),this,
                    [process,finish,finished,scannedDevices,scanReady,sound](int code,QProcess::ExitStatus status){
                if(*finished){process->deleteLater();return;}
                if(code!=0||status!=QProcess::NormalExit){finish({},"Audio refresh failed. Your current setup is unchanged.");return;}
                const auto document=QJsonDocument::fromJson(process->readAllStandardOutput());
                if(!document.isObject()||!document.object().value("devices").isArray()){
                    finish({},"Audio refresh failed. Your current setup is unchanged.");return;}
                QVariantList devices=document.object().value("devices").toArray().toVariantList();
                // A driver can omit its currently open endpoint in another process.
                const auto configured=sound->getConfig().getDevices();
                for(const auto& device:craniumAudioDeviceList(sound))if(configured.contains(device->getDeviceId())&&device->getNumOutputChannels().value()>=2&&device->getDeviceId().name!=kNetworkDeviceInternalName){
                    const auto id=craniumAudioId(device);bool present=false;
                    for(const auto& entry:devices)if(entry.toMap().value("id").toString()==id){present=true;break;}
                    if(!present)devices<<QVariantMap{{"id",id},{"name",QString(craniumAudioDisplayName(device)+" (current setup)")},{"channels",int(device->getNumOutputChannels().value())}};
                }
                *scannedDevices=devices;*scanReady=true;finish(devices,{});
            });
            connect(process,&QProcess::errorOccurred,this,[finish](QProcess::ProcessError error){
                if(error==QProcess::FailedToStart)finish({},"Audio refresh is unavailable. Your current setup is unchanged.");});
            connect(deadline,&QTimer::timeout,this,[process,finish]{process->kill();finish({},"Audio refresh took too long. Your current setup is unchanged. Try again.");});
            const auto helper=qEnvironmentVariable("CRANIUM_AUDIO_PROBE_HELPER",QCoreApplication::applicationDirPath()+"/audio-probe.py");
            process->start("/usr/bin/python3",{helper});deadline->start(12000);
        };
        services.audioRouting=[sound]{
            QVariantMap routing;const auto outputs=sound->getConfig().getOutputs();
            const auto devices=craniumAudioDeviceList(sound);
            for(auto i=outputs.constBegin();i!=outputs.constEnd();++i) {
                const auto type=i.value().getType();if(type!=AudioPath::AudioPathType::Main&&type!=AudioPath::AudioPathType::Headphones)continue;
                for(const auto& device:devices)if(device->getDeviceId()==i.key()) {
                    const QString key=type==AudioPath::AudioPathType::Main?"main":"headphones";
                    routing[key]=craniumAudioId(device);routing[key+"Base"]=int(i.value().getChannelGroup().getChannelBase());break;
                }
            }
            return routing;
        };
        services.applyAudio=[sound,scanReady](QString mainId,int mainBase,QString headId,int headBase)->QString{
            if(craniumPlaying())return "Stop playback before changing audio setup.";
            if(mainId.isEmpty())return "Choose an available master output device.";
            const auto previous=sound->getConfig();bool knownMaster=false,knownHead=headId.isEmpty();
            for(const auto& device:craniumAudioDeviceList(sound)){
                if(craniumAudioId(device)==mainId && mainBase+1<device->getNumOutputChannels().value())knownMaster=true;
                if(craniumAudioId(device)==headId && headBase+1<device->getNumOutputChannels().value())knownHead=true;
            }
            const bool refreshed=*scanReady && (!knownMaster || !knownHead);bool attempted=false;
            if(refreshed)sound->clearAndQueryDevices();
            *scanReady=false;
            const auto apply=[&]()->QString{
            SoundDevicePointer mainDevice,headDevice;
            for(const auto& device:craniumAudioDeviceList(sound)) {
                if(craniumAudioId(device)==mainId)mainDevice=device;
                if(craniumAudioId(device)==headId)headDevice=device;
            }
            if(!mainDevice)return "Choose an available master output device.";
            if(!headId.isEmpty()&&!headDevice)return "The selected headphone device is no longer available.";
            auto candidate=previous;
            const CraniumAudioEndpoint master{mainDevice->getDeviceId(),mainDevice->getHostAPI(),int(mainDevice->getNumOutputChannels().value())};
            std::optional<CraniumAudioEndpoint> headphones;
            if(headDevice)headphones=CraniumAudioEndpoint{headDevice->getDeviceId(),headDevice->getHostAPI(),int(headDevice->getNumOutputChannels().value())};
            const auto validation=craniumAudioRouting(previous,master,mainBase,headphones,headBase,&candidate);
            if(!validation.isEmpty())return validation;
            const auto rates=sound->getSampleRates(mainDevice->getHostAPI());
            if(!rates.contains(candidate.getSampleRate()))candidate.setSampleRate(mainDevice->getDefaultSampleRate());
            attempted=true;const auto status=sound->setConfig(candidate);
            return status==SoundDeviceStatus::Ok?QString():QString("Could not open the selected audio output. ")+sound->getLastErrorMessage(status);
            };
            const auto error=apply();
            if(!error.isEmpty()&&(refreshed||attempted)){
                const auto restored=sound->setConfig(previous);previous.writeToDisk();
                if(restored==SoundDeviceStatus::Ok)return error+" Previous setup restored.";
                return error+" Reconnect the previous device or choose another output.";
            }
            return error;
        };
        services.setDeveloper=[this](bool enabled){
            if(!QFileInfo::exists("/usr/local/bin/cranium-session"))return QString("Desktop controls are unavailable on this installation.");
            QProcess command;command.start("/usr/local/bin/cranium-session",{enabled?"developer":"kiosk"});
            if(!command.waitForFinished(3000)||command.exitCode()!=0)return QString("Desktop mode could not change. Cranium is still available.");
            QTimer::singleShot(0,this,[this]{updateCraniumFullscreen();});
            return enabled?QString("Developer desktop enabled. Use RETURN TO CRANIUM MODE when finished."):QString("Cranium mode restored.");
        };
        services.advanced=[this]{if(!craniumDeveloperActive())return;m_pPrefDlg->show();m_pPrefDlg->raise();m_pPrefDlg->activateWindow();};
        services.close=[this]{m_craniumSettings->hide();if(m_pCentralWidget)m_pCentralWidget->show();updateCraniumFullscreen();};
        m_craniumSettings=new CraniumSettings(std::move(services),this);
    }
    if(m_pCentralWidget)m_pCentralWidget->hide();
    m_craniumSettings->setGeometry(contentsRect());m_craniumSettings->openPage(page);
    m_craniumSettings->show();m_craniumSettings->raise();
    emit m_pCoreServices->getControllerManager()->requestCraniumRefresh();
    updateCraniumFullscreen();
}

void MixxxMainWindow::resizeEvent(QResizeEvent* event) {
    QMainWindow::resizeEvent(event);
    if(m_craniumSettings)m_craniumSettings->setGeometry(contentsRect());
}

void MixxxMainWindow::updateCraniumFullscreen() {
    if(!qEnvironmentVariableIsSet("CRANIUM_APPLIANCE")||craniumDeveloperActive())return;
    if(!isFullScreen())showFullScreen();
    if(m_pMenuBar)m_pMenuBar->hide();
    setWindowTitle("CRANIUM");
    if(m_craniumSettings&&m_craniumSettings->isVisible()){m_craniumSettings->setGeometry(contentsRect());m_craniumSettings->raise();}
}

void MixxxMainWindow::initializeCraniumAppliance() {
    if(!qEnvironmentVariableIsSet("CRANIUM_APPLIANCE"))return;
    for(const auto* scheme:{"http","https","file","mailto"})QDesktopServices::setUrlHandler(scheme,this,"slotCraniumExternalUrl");
    auto* timer=new QTimer(this);timer->setInterval(500);
    connect(timer,&QTimer::timeout,this,[this]{updateCraniumFullscreen();});timer->start();
    setWindowTitle("CRANIUM");
}

void MixxxMainWindow::slotCraniumExternalUrl(const QUrl& url) {
    if(QThread::currentThread()!=thread()) {
        QMetaObject::invokeMethod(this,[this,url]{slotCraniumExternalUrl(url);},Qt::QueuedConnection);
        return;
    }
    if(craniumDeveloperActive()){QDesktopServices::openUrl(url);return;}
    qInfo()<<"Cranium kept an external link inside the application";
    showCraniumSettings(2);m_craniumSettings->notice("Desktop links are available only in Developer Mode.");
}
