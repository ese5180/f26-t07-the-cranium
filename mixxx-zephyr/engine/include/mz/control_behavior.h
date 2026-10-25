// How a knob position maps to a control value.
//
// Ported from Mixxx's src/control/controlbehavior.cpp (ControlPotmeterBehavior,
// ControlAudioTaperPotBehavior, ControlLogPotmeterBehavior). A "parameter" is
// the knob position in [0, 1]; a "value" is what the engine uses (a gain
// ratio, a frequency, ...).
#pragma once

namespace mz {

// ControlPotmeterBehavior::midiToParameter: MIDI 64 is the centre.
double potmeterMidiToParameter(double midiValue);

// Linear potmeter (ControlPotmeter / ControlLinPotmeterBehavior).
struct LinearTaper {
    double minValue;
    double maxValue;

    double parameterToValue(double parameter) const {
        return minValue + parameter * (maxValue - minValue);
    }
    double valueToParameter(double value) const;
    double midiToParameter(double midiValue) const {
        return potmeterMidiToParameter(midiValue);
    }
};

// Audio taper: below the neutral position the gain follows minDB, above it
// maxDB. Used for channel volume (-20 dB, 0 dB, neutral 1), pregain and the
// main and headphone gains (-12 or -14 dB to +12 or +14 dB, neutral 0.5).
class AudioTaper {
  public:
    AudioTaper(double minDB, double maxDB, double neutralParameter);

    double parameterToValue(double parameter) const;
    double valueToParameter(double value) const;
    double midiToParameter(double midiValue) const;
    double maxValue() const {
        return m_maxValue;
    }

  private:
    double m_neutralParameter;
    double m_minDB;
    double m_maxDB;
    double m_offset;
    double m_midiCorrection;
    double m_maxValue;
};

// Logarithmic potmeter between two positive values, e.g. a filter corner
// frequency from 13 Hz to 22050 Hz.
class LogTaper {
  public:
    LogTaper(double minValue, double maxValue, double minDB);

    double parameterToValue(double parameter) const;
    double valueToParameter(double value) const;

  private:
    double m_minValue;
    double m_valueRange;
    double m_minDB;
    double m_minOffset;
};

} // namespace mz
