#pragma once

#include <QByteArray>
#include <QMap>
#include <QStringList>
#include <QtEndian>

namespace rx3 {
// Independent reader for rekordbox device exports. Offsets and enumerations
// are documented by pyrekordbox and rekordcrate; no upstream code is copied.
struct MySettingsResult {
    QMap<QString, double> values;
    QStringList omitted;
    QString error;
};
inline quint16 settingsChecksum(const QByteArray& bytes) {
    quint16 crc=0;
    for (const auto byte: bytes) {
        crc ^= quint16(quint8(byte))<<8;
        for (int bit=0;bit<8;++bit) crc=(crc&0x8000)?quint16((crc<<1)^0x1021):quint16(crc<<1);
    }
    return crc;
}
inline MySettingsResult readMySettings(const QString& name,const QByteArray& file) {
    MySettingsResult result;
    const bool mixer=name=="DJMMYSETTING.DAT";
    const int bodySize=mixer?52:name=="DEVSETTING.DAT"?32:40;
    if (!QStringList{"MYSETTING.DAT","MYSETTING2.DAT","DJMMYSETTING.DAT","DEVSETTING.DAT"}.contains(name)) {
        result.error="Unsupported settings file";return result;
    }
    if (file.size()!=104+bodySize+4 || qFromLittleEndian<quint32>(file.constData())!=96 ||
            qFromLittleEndian<quint32>(file.constData()+100)!=quint32(bodySize) ||
            file.mid(36,32).split('\0').first()!="rekordbox" ||
            file.mid(4,32).split('\0').first()!=(mixer?"PioneerDJ":name=="DEVSETTING.DAT"?"PIONEER DJ":"PIONEER")) {
        result.error="Invalid settings header or length";return result;
    }
    const auto payload=file.mid(104,bodySize);
    if (qFromLittleEndian<quint16>(file.constData()+104+bodySize)!=settingsChecksum(
                mixer?file.left(104+bodySize):payload) || file.right(2)!=QByteArray(2,'\0')) {
        result.error="Invalid settings checksum";return result;
    }
    auto field=[&](int offset,const QString& key,std::initializer_list<double> options) {
        const int encoded=quint8(payload[offset])-0x80;
        if (encoded<0 || encoded>=int(options.size())) {
            if (result.error.isEmpty()) result.error="Unsupported value for "+key;
            return;
        }
        result.values.insert(key,*(options.begin()+encoded));
    };
    if (name=="MYSETTING.DAT") {
        field(10,"quantize",{0,1});field(22,"sync",{0,1});
        field(11,"auto_cue_level",{-36,-42,-48,-54,-60,-66,-72,-78,0});
        field(16,"slip_flashing",{0,1});field(21,"eject_lock",{0,1});field(23,"play_mode",{0,1});
        field(24,"quantize_beat",{1,0.5,0.25,0.125});
        // Accept the current rekordbox 0x82 SETTING code and legacy 0x83 exports.
        if (quint8(payload[25])==0x83 || quint8(payload[25])==0x82) result.values.insert("hotcue_autoload",1);
        else field(25,"hotcue_autoload",{2,0}); // UI: ON / SETTING / OFF
        field(29,"needle_lock",{0,1});field(32,"time_mode",{0,1});
        field(33,"vinyl_mode",{0,1});field(34,"auto_cue",{0,1});
        field(35,"master_tempo",{0,1});field(36,"tempo_range",{0.06,0.10,0.16,1});
        result.omitted={"Hardware lights and brightness","Language","Hot cue palette","Phase meter"};
    } else if (name=="MYSETTING2.DAT") {
        field(4,"waveform_divisions",{0,1});field(12,"beatjump_size",{0.5,1,2,4,8,16,32,64});
        result.omitted={"Hardware display and pad brightness","Jog display mode","Vinyl speed adjust mode","Phase meter display"};
    } else if (mixer) {
        field(12,"channel_curve",{0,1,2});field(13,"crossfader_curve",{0,1,2});
        field(15,"headphones",{0,1});field(16,"effect_quantize",{0,1});field(17,"mic_low_cut",{0,1});field(19,"talkover_level",{-24,-18,-12,-6});
        result.omitted={"Advanced/normal hardware talkover mode","MIDI channel and button type","Hardware brightness","Headphone pre/post EQ","Long fader profile"};
    } else {
        const int encoded=quint8(payload[10]);
        if(encoded==1 || encoded==3 || encoded==4) result.values.insert("waveform_color",encoded==1?0:encoded==3?1:2);
        else result.error="Unsupported waveform color";
        result.omitted={"Device key display","Waveform current position","Overview waveform type"};
    }
    if (!result.error.isEmpty()) result.values.clear();
    return result;
}
// Patch only supported settings and recompute the format-specific checksum.
// Missing files are not fabricated: hardware-specific defaults remain owned by
// rekordbox. Unknown bytes in existing exports stay exactly as exported.
inline QByteArray writeMySettings(const QString& name,const QByteArray& original,
        const QMap<QString,double>& values,QString* error) {
    const auto checked=readMySettings(name,original);
    if(!checked.error.isEmpty()) {*error=checked.error;return {};}
    QByteArray output=original;
    auto field=[&](int offset,QString key,std::initializer_list<double> options) {
        if(!values.contains(key)) return;
        int index=0;for(double value:options) {if(qAbs(values.value(key)-value)<1e-6) {output[104+offset]=char(0x80+index);return;}++index;}
        *error="Unsupported value for "+key;
    };
    if(name=="MYSETTING.DAT") {
        field(10,"quantize",{0,1});field(11,"auto_cue_level",{-36,-42,-48,-54,-60,-66,-72,-78,0});
        field(16,"slip_flashing",{0,1});field(21,"eject_lock",{0,1});field(22,"sync",{0,1});field(23,"play_mode",{0,1});
        field(24,"quantize_beat",{1,0.5,0.25,0.125});field(25,"hotcue_autoload",{2,0,1});
        field(29,"needle_lock",{0,1});field(32,"time_mode",{0,1});field(33,"vinyl_mode",{0,1});
        field(34,"auto_cue",{0,1});field(35,"master_tempo",{0,1});field(36,"tempo_range",{0.06,0.10,0.16,1});
    } else if(name=="MYSETTING2.DAT") {
        field(4,"waveform_divisions",{0,1});field(12,"beatjump_size",{0.5,1,2,4,8,16,32,64});
    } else if(name=="DJMMYSETTING.DAT") {
        field(12,"channel_curve",{0,1,2});field(13,"crossfader_curve",{0,1,2});
        field(15,"headphones",{0,1});field(16,"effect_quantize",{0,1});field(17,"mic_low_cut",{0,1});field(19,"talkover_level",{-24,-18,-12,-6});
    } else if(values.contains("waveform_color")) {
        const int value=qRound(values.value("waveform_color"));
        if(value<0 || value>2) *error="Unsupported waveform color";
        else output[114]=char(value==0?1:value==1?3:4);
    }
    if(!error->isEmpty()) return {};
    const int size=output.size()-108;
    qToLittleEndian(settingsChecksum(name=="DJMMYSETTING.DAT"?output.left(104+size):output.mid(104,size)),output.data()+104+size);
    const auto result=readMySettings(name,output);if(!result.error.isEmpty()) {*error=result.error;return {};}
    return output;
}
} // namespace rx3
