// Ported from Mixxx's src/control/controlbehavior.cpp.
#include "mz/control_behavior.h"

#include <cmath>

#include "mz/math.h"

namespace mz {

double potmeterMidiToParameter(double midiValue) {
    if (midiValue > 64) {
        return (midiValue - 1) / 126.0;
    }
    return midiValue / 128.0;
}

double LinearTaper::valueToParameter(double value) const {
    const double range = maxValue - minValue;
    if (range == 0.0) {
        return 0.0;
    }
    return (value - minValue) / range;
}

AudioTaper::AudioTaper(double minDB, double maxDB, double neutralParameter)
        : m_neutralParameter(neutralParameter),
          m_minDB(minDB),
          m_maxDB(maxDB),
          m_offset(db2ratio(minDB)),
          m_midiCorrection(std::ceil(neutralParameter * 127) - (neutralParameter * 127)),
          m_maxValue(db2ratio(maxDB)) {
}

double AudioTaper::parameterToValue(double parameter) const {
    if (parameter <= 0.0) {
        return 0.0;
    }
    if (parameter < m_neutralParameter) {
        if (m_minDB != 0) {
            const double db = (parameter * m_minDB / (m_neutralParameter * -1)) + m_minDB;
            return (db2ratio(db) - m_offset) / (1 - m_offset);
        }
        return parameter / m_neutralParameter;
    }
    if (parameter == m_neutralParameter) {
        return 1.0;
    }
    if (parameter < 1.0) {
        return db2ratio((parameter - m_neutralParameter) * m_maxDB / (1 - m_neutralParameter));
    }
    return db2ratio(m_maxDB);
}

double AudioTaper::valueToParameter(double value) const {
    if (value <= 0.0) {
        return 0.0;
    }
    if (value < 1.0) {
        const double overlay = m_offset * (1 - value);
        if (m_minDB != 0) {
            return (ratio2db(value + overlay) - m_minDB) / m_minDB * m_neutralParameter * -1;
        }
        return value * m_neutralParameter;
    }
    if (value == 1.0) {
        return m_neutralParameter;
    }
    if (value < m_maxValue) {
        return m_neutralParameter +
                (ratio2db(value) / m_maxDB) * (1 - m_neutralParameter);
    }
    return 1.0;
}

double AudioTaper::midiToParameter(double midiValue) const {
    if (m_neutralParameter != 0 && m_neutralParameter != 1.0) {
        const double neutralTest = (midiValue - m_midiCorrection) / 127.0;
        if (neutralTest < m_neutralParameter) {
            return midiValue / (127.0 + m_midiCorrection / m_neutralParameter);
        }
        return (midiValue - m_midiCorrection / m_neutralParameter) /
                (127.0 - m_midiCorrection / m_neutralParameter);
    }
    return midiValue / 127.0;
}

LogTaper::LogTaper(double minValue, double maxValue, double minDB)
        : m_minValue(minValue),
          m_valueRange(maxValue - minValue),
          m_minDB(minDB < 0 ? minDB : -1),
          m_minOffset(db2ratio(m_minDB)) {
}

double LogTaper::parameterToValue(double parameter) const {
    const double dbParameter = (1 - parameter) * m_minDB;
    const double linParameter = (db2ratio(dbParameter) - m_minOffset) / (1 - m_minOffset);
    return m_minValue + (linParameter * m_valueRange);
}

double LogTaper::valueToParameter(double value) const {
    if (m_valueRange == 0.0) {
        return 0.0;
    }
    value = clampValue(value, m_minValue, m_minValue + m_valueRange);
    const double linParameter = (value - m_minValue) / m_valueRange;
    const double dbParameter = ratio2db(linParameter + m_minOffset * (1 - linParameter));
    return 1 - (dbParameter / m_minDB);
}

} // namespace mz
