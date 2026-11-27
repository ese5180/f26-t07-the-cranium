#pragma once

#include "controllers/midi/midienumerator.h"
#include <QStringList>

class PortMidiController;

/// This class handles discovery and enumeration of DJ controllers that appear under the PortMIDI cross-platform API.
class PortMidiEnumerator : public MidiEnumerator {
    Q_OBJECT
  public:
    PortMidiEnumerator();
    ~PortMidiEnumerator() override;

    QList<Controller*> queryDevices() override;
    bool needsRefresh();

  private:
    // Retain detached objects until shutdown to protect preference-page pointers.
    QList<PortMidiController*> m_allDevices;
    QList<Controller*> m_devices;
    QStringList m_topology;
    QStringList m_pendingTopology;
};

// For testing.
bool shouldLinkInputToOutput(const QString& input_name,
        const QString& output_name);
