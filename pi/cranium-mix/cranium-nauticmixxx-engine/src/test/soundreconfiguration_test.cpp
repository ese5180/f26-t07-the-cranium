#include <gtest/gtest.h>

#include <QElapsedTimer>
#include <QThread>
#include <future>

#include "soundio/soundmanager.h"
#include "soundio/streamcompletion.h"
#include "test/signalpathtest.h"

namespace {
SoundDeviceId outputId(const QString& name, int index) {
    SoundDeviceId id;
    id.name = name;
    id.portAudioIndex = index;
    return id;
}
} // namespace

TEST(SystemDefaultOutputTest, ReplacesSavedHdmiAndFollowsNextSystemDevice) {
    SoundManagerConfig settings(nullptr);
    settings.setAPI("Core Audio");
    const auto hdmi = outputId("HDMI", 0);
    const auto m2 = outputId("M2", 3);
    const auto speakers = outputId("Built-in Output", 1);
    const AudioOutput main(AudioPathType::Main, 0,
            mixxx::audio::ChannelCount::stereo(), 0);
    settings.addOutput(hdmi, main);
    settings.useSystemDefaultOutput(m2, "Core Audio", mixxx::audio::SampleRate(48000));
    ASSERT_EQ(1, settings.getOutputs().size());
    EXPECT_TRUE(settings.getOutputs().contains(m2, main));
    EXPECT_FALSE(settings.getOutputs().contains(hdmi));
    settings.useSystemDefaultOutput(speakers, "Core Audio", mixxx::audio::SampleRate(44100));
    EXPECT_TRUE(settings.getOutputs().contains(speakers, main));
    EXPECT_FALSE(settings.getOutputs().contains(m2));
    EXPECT_EQ(mixxx::audio::SampleRate(44100), settings.getSampleRate());
}

TEST(SystemDefaultOutputTest, PreservesIndependentHeadphonesInputsAndLatency) {
    SoundManagerConfig settings(nullptr);
    settings.setAPI("Core Audio");
    settings.setAudioBufferSizeIndex(4);
    const auto m2 = outputId("M2", 3);
    const auto controller = outputId("Controller", 2);
    const AudioOutput headphones(AudioPathType::Headphones, 2,
            mixxx::audio::ChannelCount::stereo(), 0);
    const AudioInput microphone(AudioPathType::Microphone, 0,
            mixxx::audio::ChannelCount(1), 0);
    settings.addOutput(controller, headphones);
    settings.addInput(m2, microphone);
    settings.useSystemDefaultOutput(m2, "Core Audio", mixxx::audio::SampleRate(48000));
    EXPECT_TRUE(settings.getOutputs().contains(controller, headphones));
    EXPECT_TRUE(settings.getInputs().contains(m2, microphone));
    EXPECT_EQ(4u, settings.getAudioBufferSizeIndex());
}

TEST(SystemDefaultOutputTest, KeepsExistingMasterChannelPairAndSampleRate) {
    SoundManagerConfig settings(nullptr);
    settings.setAPI("Core Audio");
    settings.setSampleRate(mixxx::audio::SampleRate(96000));
    const auto m2 = outputId("M2", 3);
    const AudioOutput main(AudioPathType::Main, 2,
            mixxx::audio::ChannelCount::stereo(), 0);
    settings.addOutput(m2, main);
    settings.useSystemDefaultOutput(m2, "Core Audio", mixxx::audio::SampleRate(48000));
    ASSERT_EQ(1, settings.getOutputs().size());
    EXPECT_EQ(2, settings.getOutputs().constBegin().value().getChannelGroup().getChannelBase());
    EXPECT_EQ(mixxx::audio::SampleRate(96000), settings.getSampleRate());
}

TEST(SystemDefaultOutputTest, AvoidsDuplicateChannelsOnNewDefaultInterface) {
    SoundManagerConfig settings(nullptr);
    settings.setAPI("Core Audio");
    const auto m2 = outputId("M2", 3);
    const AudioOutput headphones(AudioPathType::Headphones, 0,
            mixxx::audio::ChannelCount::stereo(), 0);
    settings.addOutput(m2, headphones);
    settings.useSystemDefaultOutput(m2, "Core Audio", mixxx::audio::SampleRate(48000));
    ASSERT_EQ(1, settings.getOutputs().size());
    EXPECT_EQ(AudioPathType::Main, settings.getOutputs().constBegin().value().getType());
}

TEST(SystemDefaultOutputTest, DropsDeviceRoutesFromAnotherHostApi) {
    SoundManagerConfig settings(nullptr);
    settings.setAPI("ASIO");
    const auto asioDevice = outputId("ASIO interface", 1);
    const auto systemDevice = outputId("System speakers", 2);
    settings.addOutput(asioDevice, AudioOutput(AudioPathType::Headphones, 2,
            mixxx::audio::ChannelCount::stereo(), 0));
    settings.addInput(asioDevice, AudioInput(AudioPathType::Microphone, 0,
            mixxx::audio::ChannelCount(1), 0));
    settings.useSystemDefaultOutput(systemDevice, "Windows WASAPI", mixxx::audio::SampleRate(48000));
    EXPECT_EQ(QString("Windows WASAPI"), settings.getAPI());
    EXPECT_TRUE(settings.getInputs().isEmpty());
    ASSERT_EQ(1, settings.getOutputs().size());
    EXPECT_TRUE(settings.getOutputs().contains(systemDevice));
}

class SystemDefaultOutputHardwareTest : public BaseSignalPathTest {};

TEST_F(SystemDefaultOutputHardwareTest, StartupUsesPortAudioSystemDefault) {
    if (!qEnvironmentVariableIsSet("NAUTIC_SYSTEM_OUTPUT_TEST")) {
        GTEST_SKIP() << "Set NAUTIC_SYSTEM_OUTPUT_TEST=1 to enumerate system audio hardware";
    }
    SoundManager manager(config(), m_pEngineMixer);
    const auto defaultOutput = manager.getSystemDefaultOutputDevice();
    ASSERT_TRUE(defaultOutput);
    if (qEnvironmentVariableIsSet("NAUTIC_EXPECT_DEFAULT_OUTPUT")) {
        EXPECT_EQ(qEnvironmentVariable("NAUTIC_EXPECT_DEFAULT_OUTPUT"),
                defaultOutput->getDeviceId().name);
    }
    const auto settings = manager.getConfig();
    EXPECT_EQ(defaultOutput->getHostAPI(), settings.getAPI());
    EXPECT_TRUE(settings.getOutputs().contains(defaultOutput->getDeviceId(),
            AudioOutput(AudioPathType::Main, 0, mixxx::audio::ChannelCount::stereo(), 0)));
}

TEST(StreamCompletionTest, FinishesBeforeAndDuringWait) {
    StreamCompletion completion;
    completion.finish();
    EXPECT_TRUE(completion.waitFor(std::chrono::milliseconds(0)));
    completion.reset();
    auto waiter = std::async(std::launch::async, [&completion] {
        return completion.waitFor(std::chrono::seconds(1));
    });
    completion.finish();
    EXPECT_TRUE(waiter.get());
}

TEST(StreamCompletionTest, TimeoutDoesNotPreventLateOrRepeatedCallbacks) {
    StreamCompletion completion;
    EXPECT_FALSE(completion.waitFor(std::chrono::milliseconds(5)));
    auto callback = std::async(std::launch::async, [&completion] {
        completion.finish();
        completion.finish();
    });
    EXPECT_EQ(std::future_status::ready,
            callback.wait_for(std::chrono::seconds(1)));
    callback.get();
    EXPECT_TRUE(completion.waitFor(std::chrono::milliseconds(0)));
    completion.reset();
    EXPECT_FALSE(completion.waitFor(std::chrono::milliseconds(0)));
}

// Opt-in: opens physical audio hardware and plays silence. Run the executable
// with an external process timeout so a regression fails instead of hanging CI.
class SoundReconfigurationHardwareTest : public BaseSignalPathTest {};

TEST_F(SoundReconfigurationHardwareTest, HerculesBoothWithM2Main) {
    if (!qEnvironmentVariableIsSet("NAUTIC_AUDIO_HARDWARE_TEST")) {
        GTEST_SKIP() << "Set NAUTIC_AUDIO_HARDWARE_TEST=1 with M2 and Inpulse 500 connected";
    }
    SoundManager manager(config(), m_pEngineMixer);
    SoundDevicePointer mainDevice;
    SoundDevicePointer hercules;
    for (const auto& device : manager.getDeviceList("Core Audio", true, false)) {
        if (device->getDeviceId().name == "M2") {
            mainDevice = device;
        } else if (device->getDeviceId().name == "DJControl Inpulse 500") {
            hercules = device;
        }
    }
    ASSERT_TRUE(mainDevice);
    ASSERT_TRUE(hercules);
    const AudioOutput main(AudioPathType::Main, 0,
            mixxx::audio::ChannelCount::stereo(), 0);
    const AudioOutput headphones(AudioPathType::Headphones, 2,
            mixxx::audio::ChannelCount::stereo(), 0);
    const AudioOutput booth(AudioPathType::Booth, 0,
            mixxx::audio::ChannelCount::stereo(), 0);
    const AudioOutput network(AudioPathType::RecordBroadcast, 0,
            mixxx::audio::ChannelCount::stereo(), 0);
    for (const auto& output : {main, headphones, booth, network}) {
        manager.registerOutput(output, m_pEngineMixer);
    }
    auto settings = manager.getConfig();
    settings.setAPI("Core Audio");
    settings.setAudioBufferSizeIndex(4);
    settings.clearInputs();
    for (int rate : {48000, 44100}) {
        settings.setSampleRate(mixxx::audio::SampleRate(rate));
        for (int sync : {0, 1, 2}) {
            settings.setSyncBuffers(sync);
            for (int repeat = 0; repeat < 4; ++repeat) {
                settings.clearOutputs();
                settings.addOutput(mainDevice->getDeviceId(), main);
                settings.addOutput(hercules->getDeviceId(), headphones);
                if (repeat % 2) {
                    settings.addOutput(hercules->getDeviceId(), booth);
                }
                QElapsedTimer timer;
                timer.start();
                ASSERT_EQ(SoundDeviceStatus::Ok, manager.setConfig(settings))
                        << manager.getErrorDeviceName().toStdString();
                EXPECT_LT(timer.elapsed(), 3000)
                        << "rate=" << rate << " sync=" << sync << " repeat=" << repeat;
                QThread::msleep(100);
            }
        }
    }
}
