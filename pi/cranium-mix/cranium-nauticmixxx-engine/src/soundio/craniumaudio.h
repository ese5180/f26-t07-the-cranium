#pragma once
#include <optional>
#include "soundio/soundmanagerconfig.h"

struct CraniumAudioEndpoint {
    SoundDeviceId id;
    QString api;
    int channels;
};

// Build a proposed route without touching devices or saved settings. Applying
// and rollback remain SoundManager's responsibility on the GUI thread.
inline QString craniumAudioRouting(const SoundManagerConfig& previous,
        const CraniumAudioEndpoint& master, int masterBase,
        const std::optional<CraniumAudioEndpoint>& headphones, int headphoneBase,
        SoundManagerConfig* candidate) {
    if(masterBase<0 || masterBase+1>=master.channels)return "Choose a valid stereo pair for master output.";
    if(headphones&&(headphoneBase<0||headphoneBase+1>=headphones->channels))return "Choose a valid headphone stereo pair.";
    if(headphones&&headphones->api!=master.api)return "Master and headphones must use the same audio system.";
    if(headphones&&headphones->id==master.id&&std::abs(headphoneBase-masterBase)<2)return "Choose separate stereo pairs for master and headphones.";
    if(!previous.getInputs().isEmpty()&&previous.getAPI()!=master.api)return "Existing audio inputs use another audio system. Use Developer Tools to change them.";
    auto proposed=previous;proposed.clearOutputs();
    const auto original=previous.getOutputs();
    for(auto i=original.constBegin();i!=original.constEnd();++i) {
        if(i.value().getType()==AudioPath::AudioPathType::Main||i.value().getType()==AudioPath::AudioPathType::Headphones)continue;
        if(previous.getAPI()!=master.api)return "Existing advanced audio routes use another audio system. Use Developer Tools to change them.";
        const AudioOutput main(AudioPath::AudioPathType::Main,static_cast<unsigned char>(masterBase),mixxx::audio::ChannelCount::stereo());
        if(i.key()==master.id&&main.channelsClash(i.value()))return "Master output overlaps an existing advanced audio route.";
        if(headphones&&i.key()==headphones->id){
            const AudioOutput head(AudioPath::AudioPathType::Headphones,static_cast<unsigned char>(headphoneBase),mixxx::audio::ChannelCount::stereo());
            if(head.channelsClash(i.value()))return "Headphone output overlaps an existing advanced audio route.";
        }
        proposed.addOutput(i.key(),i.value());
    }
    proposed.setAPI(master.api);
    proposed.addOutput(master.id,AudioOutput(AudioPath::AudioPathType::Main,static_cast<unsigned char>(masterBase),mixxx::audio::ChannelCount::stereo()));
    if(headphones)proposed.addOutput(headphones->id,AudioOutput(AudioPath::AudioPathType::Headphones,static_cast<unsigned char>(headphoneBase),mixxx::audio::ChannelCount::stereo()));
    *candidate=proposed;return {};
}
