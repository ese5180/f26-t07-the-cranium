#include <QtTest>
#include <QStackedWidget>
#include <QTextDocument>

#include "test/mixxxtest.h"
#include "effects/backends/builtin/filtereffect.h"
#include "effects/backends/builtin/reverbeffect.h"
#include "effects/backends/builtin/echoeffect.h"
#include "effects/backends/builtin/tremoloeffect.h"
#include "engine/effects/engineeffectparameter.h"
#include "engine/effects/engineeffectsmanager.h"
#include <vector>
#include "widget/wrx3beatfx.h"
#include "widget/weffectselector.h"
#include "skin/legacy/skincontext.h"
#include "widget/wwidgetgroup.h"
#include "widget/wnumber.h"

namespace {
QString readoutText(WLabel* label) {
    QTextDocument text;
    text.setHtml(label->text());
    return text.toPlainText();
}

// Render the real built-in DSP using values selected by the actual RX3 widget.
// This catches a lit/working pad that feeds no audio into its processor.
template<class Processor,class State>
std::vector<CSAMPLE> renderFx(const EffectSlotPointer& slot,int sampleRate,int frames,
        GroupFeatureState features,std::function<CSAMPLE(int)> source) {
    const mixxx::EngineParameters engineParameters(mixxx::audio::SampleRate(sampleRate),256);
    QMap<QString,EngineEffectParameterPointer> parameters;
    const auto processorManifest=Processor::getManifest();
    for(const auto& manifest:processorManifest->parameters()) {
        auto parameter=EngineEffectParameterPointer(new EngineEffectParameter(manifest));
        if(auto selected=rx3FxParameter(slot,manifest->id())) parameter->setValue(selected->getValue());
        parameters.insert(manifest->id(),parameter);
    }
    Processor processor;processor.loadEngineEffectParameters(parameters);
    State state(engineParameters);
    std::vector<CSAMPLE> result;result.reserve(frames*2+512);
    mixxx::SampleBuffer input(512),output(512);
    for(int offset=0;offset<frames;offset+=256) {
        for(int i=0;i<256;++i) input[2*i]=input[2*i+1]=source(offset+i);
        if(features.beat_length) features.beat_fraction_buffer_end=std::fmod((offset+256.0)/sampleRate/features.beat_length->seconds,1.0);
        processor.processChannel(&state,input.data(),output.data(),engineParameters,
                offset?EffectEnableState::Enabled:EffectEnableState::Enabling,features);
        result.insert(result.end(),output.data(),output.data()+512);
    }
    return result;
}

}

class Rx3BeatFxTest : public MixxxTest {
  protected:
    void SetUp() override {
        factory = std::make_shared<ChannelHandleFactory>();
        effects = std::make_unique<EffectsManager>(config(), factory);
        effects->registerInputChannel(ChannelHandleAndGroup(
                factory->getOrCreateHandle("[MasterOutput]"), "[MasterOutput]"));
        for (const auto& group : {QString("[Master]"), QString("[Channel1]"), QString("[Channel2]")})
            effects->registerInputChannel(ChannelHandleAndGroup(factory->getOrCreateHandle(group), group));
        effects->registerOutputChannel(ChannelHandleAndGroup(
                factory->getOrCreateHandle("[MasterOutput]"), "[MasterOutput]"));
        effects->setup();
        slot = effects->getEffectChain(WRx3BeatFx::unitGroup())->getEffectSlot(0);
        slot->loadEffectWithDefaults(nullptr);
        ControlObject::set(ConfigKey(WRx3BeatFx::unitGroup(), "enabled"), 0);
    }
    void TearDown() override { slot.clear(); effects.reset(); factory.reset(); }
    void load(const QString& id) {
        const auto manifest = effects->getBackendManager()->getManifestFromUniqueId(id);
        ASSERT_TRUE(manifest) << qPrintable(id);
        slot->loadEffectWithDefaults(manifest);
    }
    QPushButton* bank(WRx3BeatFx& panel, int index) {
        return panel.findChild<QPushButton*>(QString("RX3BankSlot%1").arg(index + 1));
    }
    double enabled() { return ControlObject::get(ConfigKey(WRx3BeatFx::unitGroup(), "enabled")); }
    void choose(WRx3BeatFx& panel, int index, const QString& effectId) {
        panel.window()->show(); panel.resize(1240, 60); panel.show();
        QTest::mouseClick(bank(panel, index), Qt::LeftButton);
        QCoreApplication::processEvents();
        QMenu* menu = nullptr;
        for (auto* candidate : panel.findChildren<QMenu*>("RX3BankEffectMenu"))
            if (candidate->isVisible()) menu = candidate;
        ASSERT_TRUE(menu);
        const auto manifest = effects->getBackendManager()->getManifestFromUniqueId(effectId);
        ASSERT_TRUE(manifest);
        QAction* selected = nullptr;
        for (auto* action : menu->actions())
            if (action->data().toString() == manifest->uniqueId()) selected = action;
        ASSERT_TRUE(selected);
        QTest::mouseClick(menu, Qt::LeftButton, Qt::NoModifier, menu->actionGeometry(selected).center());
        QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
        QCoreApplication::processEvents();
    }
    std::shared_ptr<ChannelHandleFactory> factory;
    std::unique_ptr<EffectsManager> effects;
    EffectSlotPointer slot;
};

TEST_F(Rx3BeatFxTest, ControllerCyclesVisibleBeatFxAndWrapsEveryPress) {
    QWidget parent;
    WRx3BeatFx panel(config(), effects.get(), &parent);
    WEffectSelector selector(&parent, effects.get()); selector.setObjectName("RX3BeatFxSelector");
    SkinContext context(config(), QString()); QDomDocument node;
    ASSERT_TRUE(node.setContent(QString("<EffectSelector><EffectRack>1</EffectRack><EffectUnit>1</EffectUnit><Effect>1</Effect></EffectSelector>")));
    selector.setup(node.documentElement(), context);
    const auto list=rx3BeatFxManifests(effects->getBackendManager()); ASSERT_EQ(8,list.size());
    auto pulse=[](const QString& key) {ControlObject::set(ConfigKey("[RX3BeatFx]",key),1);ControlObject::set(ConfigKey("[RX3BeatFx]",key),0);};
    for(int i=0;i<list.size()*2;++i) {
        pulse("select_next"); ASSERT_TRUE(slot->isLoaded());
        EXPECT_EQ(list[i%list.size()]->uniqueId(),slot->getManifest()->uniqueId());
        EXPECT_EQ(slot->getManifest()->uniqueId(),selector.currentData().toString());
        EXPECT_EQ(0,enabled());
    }
    // Use a real GUI selection, then ensure hardware follows that selection.
    ASSERT_TRUE(QMetaObject::invokeMethod(&selector,"slotEffectSelected",Q_ARG(int,3)));
    pulse("select_previous"); EXPECT_EQ(list[1]->uniqueId(),slot->getManifest()->uniqueId());
}

TEST_F(Rx3BeatFxTest, ControllerSelectionPreservesRoutingAmountAndActiveState) {
    QWidget parent; WRx3BeatFx panel(config(), effects.get(), &parent);
    auto pulse=[](const QString& key) {ControlObject::set(ConfigKey("[RX3BeatFx]",key),1);ControlObject::set(ConfigKey("[RX3BeatFx]",key),0);};
    pulse("toggle"); EXPECT_EQ(0,enabled()); // No phantom enable on an empty slot.
    ControlObject::set(ConfigKey(WRx3BeatFx::unitGroup(),"mix"),.73);
    ControlObject::set(ConfigKey(WRx3BeatFx::unitGroup(),"group_[Master]_enable"),0);
    ControlObject::set(ConfigKey(WRx3BeatFx::unitGroup(),"group_[Channel1]_enable"),1);
    ControlObject::set(ConfigKey(WRx3BeatFx::unitGroup(),"group_[Channel2]_enable"),0);
    pulse("select_next");
    EXPECT_DOUBLE_EQ(.73,ControlObject::get(ConfigKey(WRx3BeatFx::unitGroup(),"mix")));
    EXPECT_EQ(1,ControlObject::get(ConfigKey(WRx3BeatFx::unitGroup(),"group_[Channel1]_enable")));
    EXPECT_EQ(0,ControlObject::get(ConfigKey(WRx3BeatFx::unitGroup(),"group_[Master]_enable")));
    pulse("toggle"); EXPECT_EQ(1,enabled());
    EXPECT_EQ(1,ControlObject::get(ConfigKey(slot->getGroup(),"enabled")));
    ControlObject::set(ConfigKey("[EffectRack1_EffectUnit2]","enabled"),1);
    pulse("select_next"); EXPECT_EQ(1,enabled());
    EXPECT_EQ(1,ControlObject::get(ConfigKey(slot->getGroup(),"enabled")));
    pulse("toggle"); EXPECT_EQ(0,enabled());
    EXPECT_EQ(0,ControlObject::get(ConfigKey(slot->getGroup(),"enabled")));
    EXPECT_EQ(1,ControlObject::get(ConfigKey("[EffectRack1_EffectUnit2]","enabled")));
}

TEST_F(Rx3BeatFxTest, FourRegistrationsPersistWithoutReplacingOccupiedSlots) {
    QWidget parent;
    WRx3BeatFx panel(config(), effects.get(), &parent);
    EXPECT_EQ(4, panel.findChildren<QPushButton*>(QRegularExpression("RX3BankSlot[1-4]")).size());
    const QStringList ids{"org.mixxx.effects.echo", "org.mixxx.effects.reverb",
            "org.mixxx.effects.phaser", "org.mixxx.effects.flanger"};
    for (int index = 0; index < 4; ++index) {
        choose(panel, index, ids[index]);
        EXPECT_EQ(slot->getManifest()->uniqueId(), panel.bankId(index));
        EXPECT_EQ(0, enabled()); // Registration alone does not start an effect.
    }
    const auto saved = panel.bankId(0);
    bank(panel, 0)->click();
    EXPECT_EQ(saved, panel.bankId(0));
    EXPECT_EQ(saved, slot->getManifest()->uniqueId());
    EXPECT_EQ(1, enabled());
    saveAndReloadConfig();
    WRx3BeatFx restored(config(), effects.get(), &parent);
    for (int index = 0; index < 4; ++index) EXPECT_EQ(panel.bankId(index), restored.bankId(index));
}

TEST_F(Rx3BeatFxTest, DeleteClearsOnlyTheChosenRegistrationAndUnavailableSlotIsRetained) {
    config()->setValue(ConfigKey("[RX3BeatFxBank]", "slot4"), QStringLiteral("missing.external.effect BuiltIn"));
    QWidget parent;
    WRx3BeatFx panel(config(), effects.get(), &parent);
    load("org.mixxx.effects.echo");
    choose(panel, 0, "org.mixxx.effects.echo");
    choose(panel, 1, "org.mixxx.effects.echo");
    const auto current = slot->getManifest()->uniqueId();
    auto* remove = panel.findChild<QPushButton*>("RX3BankDelete");
    remove->click(); bank(panel, 0)->click();
    EXPECT_TRUE(panel.bankId(0).isEmpty());
    EXPECT_EQ(current, panel.bankId(1));
    EXPECT_EQ(current, slot->getManifest()->uniqueId());
    EXPECT_EQ(0, enabled());
    EXPECT_FALSE(remove->isChecked());
    bank(panel, 3)->click();
    EXPECT_EQ("missing.external.effect BuiltIn", panel.bankId(3));
    EXPECT_EQ(current, slot->getManifest()->uniqueId());
    remove->click(); bank(panel, 3)->click();
    EXPECT_TRUE(panel.bankId(3).isEmpty());
}

TEST_F(Rx3BeatFxTest, XPadChangesEffectTimeAndIsMomentaryWithoutChangingDeckLoops) {
    ControlObject loop(ConfigKey("[Channel1]", "loop_enabled"), false, false, false, 1);
    ControlObject size(ConfigKey("[Channel1]", "beatloop_size"), false, false, false, 8);
    ControlObject play(ConfigKey("[Channel1]", "play"), false, false, false, 1);
    ControlObject color(ConfigKey("[QuickEffectRack1_[Channel1]]", "super1"), false, false, false, 0.3);
    ControlObject::set(ConfigKey("[EffectRack1_EffectUnit2]", "enabled"), 1);
    QWidget parent;
    WRx3BeatFx panel(config(), effects.get(), &parent);
    panel.resize(1240, 60); parent.resize(1280, 80); parent.show(); panel.show();
    load("org.mixxx.effects.echo");
    auto* pad = panel.findChild<QSlider*>("RX3XPadSlider");
    QCoreApplication::processEvents();
    ASSERT_TRUE(pad->isEnabled());
    EXPECT_EQ("delay_time", panel.parameterId());
    const double before = WRx3BeatFx::parameterForId(slot, "delay_time")->getValue();
    QTest::mousePress(pad, Qt::LeftButton, Qt::NoModifier, QPoint(pad->width() / 4, 20));
    EXPECT_EQ(1, enabled());
    QMouseEvent move(QEvent::MouseMove, QPointF(pad->width() * 3 / 4, 20),
            pad->mapToGlobal(QPoint(pad->width() * 3 / 4, 20)), Qt::NoButton,
            Qt::LeftButton, Qt::NoModifier);
    QCoreApplication::sendEvent(pad, &move);
    EXPECT_GT(WRx3BeatFx::parameterForId(slot, "delay_time")->getValue(), before);
    QTest::mouseRelease(pad, Qt::LeftButton, Qt::NoModifier, QPoint(pad->width() * 3 / 4, 20));
    EXPECT_EQ(0, enabled());
    EXPECT_EQ(1, loop.get()); EXPECT_EQ(8, size.get()); EXPECT_EQ(1, play.get());
    EXPECT_DOUBLE_EQ(0.3, color.get());
    EXPECT_EQ(1, ControlObject::get(ConfigKey("[EffectRack1_EffectUnit2]", "enabled")));
    // Touching an effect already enabled by the bank still turns it off on release.
    ControlObject::set(ConfigKey(WRx3BeatFx::unitGroup(), "enabled"), 1);
    QTest::mousePress(pad, Qt::LeftButton, Qt::NoModifier, QPoint(pad->width() / 4, 20));
    QTest::mouseRelease(pad, Qt::LeftButton, Qt::NoModifier, QPoint(pad->width() / 4, 20));
    EXPECT_EQ(0, enabled());
}

TEST_F(Rx3BeatFxTest, ParameterSelectionIsContextualAndControllerChangesRefreshXPad) {
    QWidget parent;
    WRx3BeatFx panel(config(), effects.get(), &parent);
    auto* pad = panel.findChild<QSlider*>("RX3XPadSlider");
    EXPECT_FALSE(pad->isEnabled());
    for (const auto& pair : QList<QPair<QString, QString>>{
                 {"org.mixxx.effects.echo", "delay_time"}, {"org.mixxx.effects.reverb", "decay"},
                 {"org.mixxx.effects.phaser", "lfo_period"}, {"org.mixxx.effects.flanger", "speed"},
                 {"org.mixxx.effects.filter", "lpf"}, {"org.mixxx.effects.pitchshift", "pitch"},
                 {"org.mixxx.effects.distortion", "drive"}}) {
        load(pair.first);
        ASSERT_TRUE(slot->isLoaded());
        EXPECT_EQ(pair.second, panel.parameterId());
        ASSERT_TRUE(pad->isEnabled());
        pad->setValue(750);
        auto parameter = WRx3BeatFx::parameterForId(slot, pair.second);
        ASSERT_TRUE(parameter);
        const double value = parameter->getValue();
        pad->setValue(250);
        EXPECT_NE(parameter->getValue(), value);
        EXPECT_EQ(0, enabled());
    }
    load("org.mixxx.effects.echo");
    ControlObject::set(ConfigKey(slot->getGroup(), "parameter1"), 1.5);
    EXPECT_NEAR(375, pad->value(), 1);
    slot->loadEffectWithDefaults(nullptr);
    EXPECT_FALSE(pad->isEnabled());
}

TEST_F(Rx3BeatFxTest, StatusBeatFxSwitchDoesNotEnableDisableOrReplaceEffect) {
    QStackedWidget pages;
    pages.addWidget(new QWidget);
    auto* panel = new WRx3BeatFx(config(), effects.get(), &pages);
    pages.addWidget(panel); pages.resize(1280, 80); pages.show();
    load("org.mixxx.effects.echo");
    const auto id = slot->getManifest()->uniqueId();
    for (int state : {0, 1}) {
        ControlObject::set(ConfigKey(WRx3BeatFx::unitGroup(), "enabled"), state);
        for (int repeat = 0; repeat < 3; ++repeat) {
            pages.setCurrentIndex(1); QCoreApplication::processEvents();
            pages.setCurrentIndex(0); QCoreApplication::processEvents();
            EXPECT_EQ(state, enabled());
            EXPECT_EQ(id, slot->getManifest()->uniqueId());
        }
    }
}

TEST_F(Rx3BeatFxTest, HidingPressedXPadCancelsMomentaryEffectAndReadoutFollowsTime) {
    QWidget parent;
    auto* time = new WLabel(&parent); time->setObjectName("RX3BeatFxMilliseconds");
    auto* beat = new WLabel(&parent); beat->setObjectName("RX3BeatFxBeat");
    ControlObject bpm(ConfigKey("[RX3Display]", "master_bpm"), false, false, false, 120);
    WRx3BeatFx panel(config(), effects.get(), &parent);
    parent.resize(1280, 100); panel.resize(1240, 60); parent.show(); panel.show();
    load("org.mixxx.effects.echo");
    ControlObject::set(ConfigKey(slot->getGroup(), "parameter1"), 1);
    EXPECT_EQ("1 BEAT", readoutText(beat)); EXPECT_EQ("500 msec", readoutText(time));
    bpm.set(100); EXPECT_EQ("600 msec", readoutText(time));
    time->resize(180, 30); beat->resize(180, 30);
    QCoreApplication::processEvents();
    EXPECT_EQ("600 msec", readoutText(time)); EXPECT_EQ("1 BEAT", readoutText(beat));
    auto* pad = panel.findChild<QSlider*>("RX3XPadSlider");
    QCoreApplication::processEvents();
    QTest::mousePress(pad, Qt::LeftButton, Qt::NoModifier, QPoint(pad->width() / 4, 20));
    EXPECT_EQ(1, enabled());
    panel.hide();
    EXPECT_EQ(0, enabled());
    EXPECT_FALSE(pad->isSliderDown());
    const auto output = qEnvironmentVariable("NAUTIC_RX3_PANEL_QA_DIR");
    if (!output.isEmpty()) {
        const auto skin = qEnvironmentVariable("NAUTIC_RX3_SKIN_PATH");
        QFile xml(skin + "/beffect.xml"), css(skin + "/style.qss");
        ASSERT_TRUE(xml.open(QIODevice::ReadOnly)); ASSERT_TRUE(css.open(QIODevice::ReadOnly));
        QDomDocument doc; ASSERT_TRUE(doc.setContent(xml.readAll()));
        QWidget canvas; canvas.setObjectName("SidePanel_Container");
        canvas.setStyleSheet(QString::fromUtf8(css.readAll()));
        SkinContext context(config(), skin);
        std::function<QWidget*(QDomElement, QWidget*)> create;
        create = [&](QDomElement node, QWidget* owner) -> QWidget* {
            QWidget* widget = nullptr;
            const auto name = node.firstChildElement("ObjectName").text();
            if (node.tagName() == "WidgetGroup") {
                auto* group = new WWidgetGroup(owner); group->setObjectName(name);
                group->setup(node, context); widget = group;
                const auto children = node.firstChildElement("Children");
                for (auto child = children.firstChildElement(); !child.isNull(); child = child.nextSiblingElement())
                    group->layout()->addWidget(create(child, group));
            } else if (node.tagName() == "PushButton") {
                auto* button = new QPushButton(owner); widget = button;
                button->setText(node.firstChildElement("State").firstChildElement("Text").text());
                button->setProperty("displayValue", name == "RX3FxMaster" || button->text() == "BEAT FX" ? 1 : 0);
            } else if (node.tagName() == "EffectSelector") {
                auto* selector = new WEffectSelector(owner, effects.get()); widget = selector;
                selector->setObjectName(name); selector->setup(node, context);
            } else if (node.tagName() == "Number") {
                auto* number = new WNumber(owner); widget = number;
                number->setObjectName(name); number->setup(node, context); number->setValue(87);
            } else {
                auto* label = new WLabel(owner); widget = label;
                label->setObjectName(name); label->setup(node, context);
            }
            widget->setObjectName(name);
            const auto size = node.firstChildElement("Size").text().split(',');
            if (size.size() == 2) {
                if (size[0].endsWith('f')) widget->setFixedWidth(size[0].chopped(1).toInt());
                if (size[1].endsWith('f')) widget->setFixedHeight(size[1].chopped(1).toInt());
            }
            return widget;
        };
        auto* body = create(doc.documentElement().firstChildElement("WidgetGroup"), &canvas);
        body->setGeometry(0, 0, 184, 428); canvas.resize(184, 428);
        WRx3BeatFx bindings(config(), effects.get(), &canvas); bindings.hide();
        bpm.set(87); ControlObject::set(ConfigKey(slot->getGroup(), "parameter1"), 1);
        canvas.show(); body->show(); QCoreApplication::processEvents();
        ASSERT_TRUE(canvas.grab().save(output + "/beatfx-panel.png"));
    }
}

TEST_F(Rx3BeatFxTest, TouchSlideAndCancelAreMomentary) {
    QWidget parent;
    WRx3BeatFx panel(config(), effects.get(), &parent);
    parent.resize(1280, 100); panel.resize(1240, 60); parent.show(); panel.show();
    load("org.mixxx.effects.echo");
    auto* pad = panel.findChild<QSlider*>("RX3XPadSlider");
    QCoreApplication::processEvents();
    const auto renderDirectory = qEnvironmentVariable("RX3_XPAD_RENDER_DIR");
    auto capture = [pad, renderDirectory](const QString& name) {
        if (!renderDirectory.isEmpty()) {
            QDir().mkpath(renderDirectory);
            EXPECT_TRUE(pad->grab().save(renderDirectory + "/" + name + ".png"));
        }
    };
    capture("idle");
    auto* device = QTest::createTouchDevice(QInputDevice::DeviceType::TouchScreen);
    QTest::touchEvent(pad, device).press(0, QPoint(pad->width() / 4, 20), pad);
    QCoreApplication::processEvents();
    EXPECT_EQ(1, enabled());
    const auto parameter = WRx3BeatFx::parameterForId(slot, "delay_time");
    const double before = parameter->getValue();
    capture("pressed");
    QTest::touchEvent(pad, device).move(0, QPoint(pad->width() * 3 / 4, 20), pad);
    QCoreApplication::processEvents();
    EXPECT_GT(parameter->getValue(), before);
    QTouchEvent cancel(QEvent::TouchCancel, device);
    QCoreApplication::sendEvent(pad, &cancel);
    EXPECT_EQ(0, enabled());
    EXPECT_FALSE(pad->isSliderDown());
    capture("released");
}

TEST_F(Rx3BeatFxTest, ReadoutRespectsProcessorQuantizeTripletAndReciprocalRate) {
    QWidget parent;
    auto* time = new WLabel(&parent); time->setObjectName("RX3BeatFxMilliseconds");
    auto* beat = new WLabel(&parent); beat->setObjectName("RX3BeatFxBeat");
    ControlObject bpm(ConfigKey("[RX3Display]", "master_bpm"), false, false, false, 120);
    WRx3BeatFx panel(config(), effects.get(), &parent);
    auto setButton = [this](const QString& id, double value) {
        for (unsigned int index = 0; index < slot->numParameters(EffectParameterType::Button); ++index) {
            const auto button = slot->getEffectParameterSlot(EffectParameterType::Button, index);
            if (button->getManifest() && button->getManifest()->id() == id) {
                button->setParameter(value); return;
            }
        }
        FAIL() << "Missing button " << qPrintable(id);
    };
    load("org.mixxx.effects.echo");
    ControlObject::set(ConfigKey(slot->getGroup(), "parameter1"), 1);
    setButton("triplet", 1);
    EXPECT_EQ("0.333 BEAT", readoutText(beat));
    setButton("quantize", 0);
    EXPECT_EQ("1 BEAT", readoutText(beat));
    bpm.set(0);
    EXPECT_EQ("1 SEC", readoutText(beat)); EXPECT_EQ("1000 msec", readoutText(time));
    bpm.set(120);
    load("org.mixxx.effects.tremolo");
    ASSERT_EQ("rate", panel.parameterId());
    for (unsigned int index = 0; index < slot->numParameters(EffectParameterType::Knob); ++index) {
        const auto knob = slot->getEffectParameterSlot(EffectParameterType::Knob, index);
        if (knob->getManifest() && knob->getManifest()->id() == "rate")
            ControlObject::set(ConfigKey(slot->getGroup(), QString("parameter%1").arg(index + 1)), 2);
    }
    EXPECT_EQ("0.5 BEAT", readoutText(beat)); EXPECT_EQ("250 msec", readoutText(time));
    setButton("triplet", 1);
    EXPECT_EQ("0.167 BEAT", readoutText(beat));
    setButton("quantize", 0);
    EXPECT_EQ("0.5 BEAT", readoutText(beat));
}

TEST_F(Rx3BeatFxTest, XPadUsesFractionsForTimeAndGradientForContinuousParameters) {
    QWidget parent;
    auto* beat = new WLabel(&parent); beat->setObjectName("RX3BeatFxBeat");
    ControlObject bpm(ConfigKey("[RX3Display]", "master_bpm"), false, false, false, 120);
    WRx3BeatFx panel(config(), effects.get(), &parent);
    parent.resize(1280, 100); panel.resize(1240, 60); parent.show(); panel.show();
    auto* pad = panel.findChild<WRx3XPad*>("RX3XPadSlider");
    ASSERT_TRUE(pad);
    const auto renderDirectory = qEnvironmentVariable("RX3_XPAD_RENDER_DIR");
    auto capture = [pad, renderDirectory](const QString& name) {
        if (!renderDirectory.isEmpty()) {
            QDir().mkpath(renderDirectory);
            EXPECT_TRUE(pad->grab().save(renderDirectory + "/" + name + ".png"));
        }
    };
    EXPECT_EQ(WRx3XPad::Layout::Empty, pad->presentation());
    QCoreApplication::processEvents();
    capture("empty-idle");
    load("org.mixxx.effects.echo");
    QCoreApplication::processEvents();
    EXPECT_EQ(WRx3XPad::Layout::Beats, pad->presentation());
    ASSERT_EQ(8, pad->cells().size());
    EXPECT_EQ("1/16", pad->cells()[0].label);
    EXPECT_EQ("4", pad->cells()[7].label);
    EXPECT_TRUE(pad->cells()[0].enabled); EXPECT_TRUE(pad->cells()[7].enabled);
    const auto before = WRx3BeatFx::parameterForId(slot, "delay_time")->getValue();
    QTest::mousePress(pad, Qt::LeftButton, Qt::NoModifier, QPoint(2, 20));
    QTest::mouseRelease(pad, Qt::LeftButton, Qt::NoModifier, QPoint(2, 20));
    EXPECT_EQ(0, enabled());
    EXPECT_DOUBLE_EQ(0.0625, WRx3BeatFx::parameterForId(slot, "delay_time")->getValue());
    EXPECT_NE(before, WRx3BeatFx::parameterForId(slot, "delay_time")->getValue());
    QTest::mousePress(pad, Qt::LeftButton, Qt::NoModifier, QPoint(pad->width() * 3 / 16, 20));
    EXPECT_EQ(1, enabled()); EXPECT_EQ("0.125 BEAT", readoutText(beat));
    capture("echo-pressed");
    QTest::mouseRelease(pad, Qt::LeftButton, Qt::NoModifier, QPoint(pad->width() * 3 / 16, 20));
    load("org.mixxx.effects.reverb");
    EXPECT_EQ(WRx3XPad::Layout::Continuous, pad->presentation());
    capture("reverb-idle");
    const auto cutoff = WRx3BeatFx::parameterForId(slot, "decay");
    QTest::mousePress(pad, Qt::LeftButton, Qt::NoModifier, QPoint(pad->width() / 4, 20));
    const double first = cutoff->getValue();
    QMouseEvent move(QEvent::MouseMove, QPointF(pad->width() * 3 / 4, 20),
            pad->mapToGlobal(QPoint(pad->width() * 3 / 4, 20)), Qt::NoButton,
            Qt::LeftButton, Qt::NoModifier);
    QCoreApplication::sendEvent(pad, &move);
    EXPECT_NE(first, cutoff->getValue());
    capture("reverb-pressed");
    QTest::mouseRelease(pad, Qt::LeftButton, Qt::NoModifier, QPoint(pad->width() * 3 / 4, 20));
    EXPECT_EQ(0, enabled());
    capture("reverb-released");
    load("org.mixxx.effects.flanger");
    EXPECT_EQ(WRx3XPad::Layout::Continuous, pad->presentation());
    load("org.mixxx.effects.phaser");
    EXPECT_EQ(WRx3XPad::Layout::Beats, pad->presentation());
}

TEST_F(Rx3BeatFxTest, PitchCellsSetSemitonesAndEffectChangeCancelsHeldPad) {
    QWidget parent;
    auto* beat = new WLabel(&parent); beat->setObjectName("RX3BeatFxBeat");
    WRx3BeatFx panel(config(), effects.get(), &parent);
    parent.resize(1280, 100); panel.resize(1240, 60); parent.show(); panel.show();
    auto* pad = panel.findChild<WRx3XPad*>("RX3XPadSlider");
    load("org.mixxx.effects.pitchshift");
    QCoreApplication::processEvents();
    EXPECT_EQ(WRx3XPad::Layout::Pitch, pad->presentation());
    ASSERT_EQ(7, pad->cells().size());
    EXPECT_EQ("-12", pad->cells().first().label); EXPECT_EQ("+12", pad->cells().last().label);
    QTest::mousePress(pad, Qt::LeftButton, Qt::NoModifier, QPoint(pad->width() * 9 / 14, 20));
    EXPECT_EQ(1, enabled()); EXPECT_EQ("5 ST", readoutText(beat));
    EXPECT_EQ(1, WRx3BeatFx::parameterForId(slot, "range")->getValue());
    EXPECT_NEAR(5.0 / 12, WRx3BeatFx::parameterForId(slot, "pitch")->getValue(), 0.00001);
    const auto renderDirectory = qEnvironmentVariable("RX3_XPAD_RENDER_DIR");
    if (!renderDirectory.isEmpty()) EXPECT_TRUE(pad->grab().save(renderDirectory + "/pitch-pressed.png"));
    QMouseEvent move(QEvent::MouseMove, QPointF(pad->width() * 3 / 14, 20),
            pad->mapToGlobal(QPoint(pad->width() * 3 / 14, 20)), Qt::NoButton,
            Qt::LeftButton, Qt::NoModifier);
    QCoreApplication::sendEvent(pad, &move);
    EXPECT_EQ("-7 ST", readoutText(beat));
    EXPECT_NEAR(-7.0 / 12, WRx3BeatFx::parameterForId(slot, "pitch")->getValue(), 0.00001);
    load("org.mixxx.effects.echo");
    EXPECT_FALSE(pad->isSliderDown()); EXPECT_EQ(0, enabled());
    EXPECT_EQ(WRx3XPad::Layout::Beats, pad->presentation());
}

TEST_F(Rx3BeatFxTest, EmptyBankSlotOpensMouseChooserAndRegistersWithoutActivation) {
    QWidget parent;
    WRx3BeatFx panel(config(), effects.get(), &parent);
    parent.resize(1280, 100); panel.resize(1240, 60); parent.show(); panel.show();
    QCoreApplication::processEvents();
    for (int index = 0; index < 4; ++index) EXPECT_TRUE(bank(panel, index)->isEnabled());
    QTest::mouseClick(bank(panel, 2), Qt::LeftButton);
    QCoreApplication::processEvents();
    auto* menu = panel.findChild<QMenu*>("RX3BankEffectMenu");
    ASSERT_TRUE(menu); ASSERT_TRUE(menu->isVisible());
    QAction* echo = nullptr;
    for (auto* action : menu->actions())
        if (action->data().toString().startsWith("org.mixxx.effects.echo ")) echo = action;
    ASSERT_TRUE(echo);
    const auto id = echo->data().toString();
    QTest::mouseClick(menu, Qt::LeftButton, Qt::NoModifier, menu->actionGeometry(echo).center());
    QCoreApplication::processEvents();
    EXPECT_EQ(id, panel.bankId(2)); EXPECT_EQ(id, slot->getManifest()->uniqueId());
    EXPECT_EQ(0, enabled());
    EXPECT_EQ(0, ControlObject::get(ConfigKey(slot->getGroup(), "enabled")));
    QTest::mouseClick(bank(panel, 2), Qt::LeftButton);
    EXPECT_EQ(1, enabled());
    slot->loadEffectWithDefaults(nullptr);
    ControlObject::set(ConfigKey(WRx3BeatFx::unitGroup(), "enabled"), 0);
    QTest::mouseClick(bank(panel, 0), Qt::LeftButton);
    QCoreApplication::processEvents();
    menu = panel.findChild<QMenu*>("RX3BankEffectMenu");
    ASSERT_TRUE(menu); menu->close(); QCoreApplication::processEvents();
    EXPECT_TRUE(panel.bankId(0).isEmpty()); EXPECT_EQ(0, enabled());
}

TEST_F(Rx3BeatFxTest, EveryEmptySlotOffersOnlyPerformanceEffectsEvenWithAnEffectSelected) {
    QWidget parent;
    WRx3BeatFx panel(config(), effects.get(), &parent);
    parent.resize(1280, 100); panel.resize(1240, 60); parent.show(); panel.show();
    const QStringList ids{"org.mixxx.effects.echo", "org.mixxx.effects.reverb",
            "org.mixxx.effects.flanger", "org.mixxx.effects.pitchshift"};
    for (int index = 0; index < 4; ++index) {
        QTest::mouseClick(bank(panel, index), Qt::LeftButton);
        QCoreApplication::processEvents();
        auto* menu = panel.findChild<QMenu*>("RX3BankEffectMenu");
        ASSERT_TRUE(menu); ASSERT_TRUE(menu->isVisible());
        EXPECT_EQ(8, menu->actions().size());
        for (auto* action : menu->actions()) {
            const auto manifest = effects->getBackendManager()->getManifestFromUniqueId(action->data().toString());
            ASSERT_TRUE(manifest);
            EXPECT_TRUE(isRx3BeatFx(manifest));
            EXPECT_FALSE(manifest->name().contains("Loudness"));
        }
        menu->close(); QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
        choose(panel, index, ids[index]);
        EXPECT_EQ(effects->getBackendManager()->getManifestFromUniqueId(ids[index])->uniqueId(), panel.bankId(index));
        EXPECT_EQ(0, enabled());
    }
    bank(panel, 0)->click();
    EXPECT_EQ(1, enabled());
    for (int index = 1; index < 4; ++index) EXPECT_NE(panel.bankId(0), panel.bankId(index));
}

TEST_F(Rx3BeatFxTest, RegisteringThePlayingEffectPreservesParametersAndActivation) {
    QWidget parent;
    WRx3BeatFx panel(config(), effects.get(), &parent);
    load("org.mixxx.effects.echo");
    ControlObject::set(ConfigKey(slot->getGroup(), "parameter1"), 1.5);
    slot->setEnabled(true);
    ControlObject::set(ConfigKey(WRx3BeatFx::unitGroup(), "enabled"), 1);
    choose(panel, 0, "org.mixxx.effects.echo");
    EXPECT_EQ(1, enabled());
    EXPECT_EQ(1, ControlObject::get(ConfigKey(slot->getGroup(), "enabled")));
    EXPECT_DOUBLE_EQ(1.5, WRx3BeatFx::parameterForId(slot, "delay_time")->getValue());
}

TEST_F(Rx3BeatFxTest, Rx3SelectorIsCuratedWithoutRestrictingOtherSkins) {
    effects->getVisibleEffectsList()->setList(effects->getBackendManager()->getManifests());
    QWidget parent;
    WEffectSelector rx3(&parent, effects.get()), generic(&parent, effects.get());
    rx3.setObjectName("RX3BeatFxSelector");
    SkinContext context(config(), QString()); QDomDocument node;
    ASSERT_TRUE(node.setContent(QStringLiteral("<EffectSelector><EffectUnit>1</EffectUnit><Effect>1</Effect></EffectSelector>")));
    rx3.setup(node.documentElement(), context); generic.setup(node.documentElement(), context);
    EXPECT_EQ(9, rx3.count()); // Eight processors plus the no-effect item.
    EXPECT_GT(generic.count(), rx3.count());
    for (int index = 1; index < rx3.count(); ++index)
        EXPECT_TRUE(isRx3BeatFx(effects->getBackendManager()->getManifestFromUniqueId(rx3.itemData(index).toString())));
}

TEST_F(Rx3BeatFxTest, OldUtilityFavoriteOpensChooserAndCanBeRepairedIndependently) {
    const auto utility = effects->getBackendManager()->getManifestFromUniqueId("org.mixxx.effects.loudnesscontour");
    ASSERT_TRUE(utility);
    config()->setValue(ConfigKey("[RX3BeatFxBank]", "slot1"), utility->uniqueId());
    config()->setValue(ConfigKey("[RX3BeatFxBank]", "slot2"), utility->uniqueId());
    QWidget parent;
    WRx3BeatFx panel(config(), effects.get(), &parent);
    EXPECT_TRUE(bank(panel, 0)->text().isEmpty());
    EXPECT_TRUE(bank(panel, 0)->property("empty").toBool());
    EXPECT_EQ(utility->uniqueId(), panel.bankId(0));
    choose(panel, 0, "org.mixxx.effects.reverb");
    EXPECT_EQ("REVERB", bank(panel, 0)->text());
    EXPECT_EQ(utility->uniqueId(), panel.bankId(1));
    EXPECT_TRUE(bank(panel, 1)->text().isEmpty());
    EXPECT_TRUE(bank(panel, 1)->property("empty").toBool());
    EXPECT_EQ(0, enabled());
}

TEST_F(Rx3BeatFxTest, SelectedFavoriteAndBeatOutlineSurviveMomentaryXPadRelease) {
    QWidget parent;
    WRx3BeatFx panel(config(), effects.get(), &parent);
    parent.resize(1280, 100); panel.resize(1240, 60);
    choose(panel, 0, "org.mixxx.effects.echo");
    choose(panel, 1, "org.mixxx.effects.reverb");
    bank(panel, 0)->click();
    const auto echoId = panel.bankId(0);
    auto* pad = panel.findChild<WRx3XPad*>("RX3XPadSlider");
    ASSERT_TRUE(pad);
    const QPoint halfBeat(pad->width() * 7 / 16, 20);
    QTest::mousePress(pad, Qt::LeftButton, Qt::NoModifier, halfBeat);
    EXPECT_TRUE(bank(panel, 0)->property("selected").toBool());
    EXPECT_FALSE(bank(panel, 1)->property("selected").toBool());
    QTest::mouseRelease(pad, Qt::LeftButton, Qt::NoModifier, halfBeat);
    EXPECT_EQ(0, enabled()); // Momentary activation ends; selection remains.
    EXPECT_EQ(echoId, slot->getManifest()->uniqueId());
    EXPECT_TRUE(bank(panel, 0)->property("selected").toBool());
    EXPECT_FALSE(bank(panel, 1)->property("selected").toBool());
    EXPECT_DOUBLE_EQ(0.5, WRx3BeatFx::parameterForId(slot, "delay_time")->getValue());
    const auto image = pad->grab().toImage();
    const qreal ratio = image.devicePixelRatio();
    const auto color = [&](int x, int y) {
        return image.pixelColor(qRound(x * ratio), qRound(y * ratio));
    };
    EXPECT_EQ(QColor(Qt::white), color(halfBeat.x(), 1));
    EXPECT_NE(QColor(Qt::white), color(halfBeat.x(), 2));
    EXPECT_NE(QColor(Qt::white), color(pad->width() / 16, 1));
    const auto directory = qEnvironmentVariable("RX3_XPAD_RENDER_DIR");
    if (!directory.isEmpty()) EXPECT_TRUE(image.save(directory + "/echo-half-selected-released.png"));
    QTest::mousePress(pad, Qt::LeftButton, Qt::NoModifier, halfBeat);
    QTest::mouseRelease(pad, Qt::LeftButton, Qt::NoModifier, halfBeat);
    EXPECT_TRUE(bank(panel, 0)->property("selected").toBool());
    bank(panel, 1)->click();
    EXPECT_FALSE(bank(panel, 0)->property("selected").toBool());
    EXPECT_TRUE(bank(panel, 1)->property("selected").toBool());
}

TEST_F(Rx3BeatFxTest, BankReloadAndSelectorDiscardUnsafeInheritedMetaOnlyForNewEffects) {
    QWidget parent;
    WRx3BeatFx panel(config(),effects.get(),&parent);
    choose(panel,0,"org.mixxx.effects.filter");
    choose(panel,1,"org.mixxx.effects.reverb");
    choose(panel,2,"org.mixxx.effects.tremolo");
    for(double meta:{0.0,0.5,1.0}) {
        load("org.mixxx.effects.echo");slot->setMetaParameter(meta,true);
        panel.recallBank(0);
        EXPECT_DOUBLE_EQ(22050,rx3FxParameter(slot,"lpf")->getValue());
        EXPECT_DOUBLE_EQ(13,rx3FxParameter(slot,"hpf")->getValue());
        panel.recallBank(1);
        EXPECT_DOUBLE_EQ(1,rx3FxParameter(slot,"send_amount")->getValue());
        panel.recallBank(2);
        EXPECT_DOUBLE_EQ(1,rx3FxParameter(slot,"depth")->getValue());
    }
    EXPECT_DOUBLE_EQ(0.5,ControlObject::get(ConfigKey(WRx3BeatFx::unitGroup(),"mix")));
    panel.setAmount(0.7);EXPECT_DOUBLE_EQ(0.7,ControlObject::get(ConfigKey(WRx3BeatFx::unitGroup(),"mix")));
    WEffectSelector selector(&parent,effects.get());selector.setObjectName("RX3BeatFxSelector");
    SkinContext context(config(),QString());QDomDocument node;
    ASSERT_TRUE(node.setContent(QStringLiteral("<EffectSelector><EffectUnit>1</EffectUnit><Effect>1</Effect></EffectSelector>")));
    selector.setup(node.documentElement(),context);
    slot->setMetaParameter(0,true);
    const auto filter=effects->getBackendManager()->getManifestFromUniqueId("org.mixxx.effects.filter");
    const int index=selector.findData(filter->uniqueId());ASSERT_GT(index,0);
    selector.activated(index);
    EXPECT_EQ(0,enabled());EXPECT_DOUBLE_EQ(22050,rx3FxParameter(slot,"lpf")->getValue());
}

TEST_F(Rx3BeatFxTest, LongBankPressReplacesRegistrationWithoutReleaseRecall) {
    QWidget parent;WRx3BeatFx panel(config(),effects.get(),&parent);
    choose(panel,0,"org.mixxx.effects.echo");
    panel.setActive(false);
    QTest::mousePress(bank(panel,0),Qt::LeftButton);
    QTest::qWait(700);
    auto* menu=panel.findChild<QMenu*>("RX3BankEffectMenu");ASSERT_TRUE(menu);ASSERT_TRUE(menu->isVisible());
    QAction* replacement=nullptr;
    for(auto* action:menu->actions()) if(action->data().toString().startsWith("org.mixxx.effects.reverb ")) replacement=action;
    ASSERT_TRUE(replacement);
    QTest::mouseClick(menu,Qt::LeftButton,Qt::NoModifier,menu->actionGeometry(replacement).center());
    QTest::mouseRelease(bank(panel,0),Qt::LeftButton);
    EXPECT_EQ("REVERB",bank(panel,0)->text());EXPECT_EQ(0,enabled());
    panel.recallBank(0);EXPECT_EQ(1,enabled());
}

TEST_F(Rx3BeatFxTest, CommonControllerCommandsSupportBanksAmountAndExactPadPeriods) {
    QWidget parent;WRx3BeatFx panel(config(),effects.get(),&parent);
    const auto echo=effects->getBackendManager()->getManifestFromUniqueId("org.mixxx.effects.echo");
    panel.selectEffect(echo,false);
    ControlObject::set(ConfigKey("[RX3BeatFx]","bank_store"),2);
    EXPECT_EQ(echo->uniqueId(),panel.bankId(1));
    ControlObject::set(ConfigKey("[RX3BeatFx]","bank_recall"),2);EXPECT_EQ(1,enabled());
    ControlObject::set(ConfigKey("[RX3BeatFx]","amount"),0.6);EXPECT_DOUBLE_EQ(0.6,panel.amount());
    ControlObject::set(ConfigKey("[RX3BeatFx]","xpad_position"),0.001);
    ControlObject::set(ConfigKey("[RX3BeatFx]","xpad_hold"),1);
    EXPECT_EQ(1,enabled());EXPECT_DOUBLE_EQ(0.0625,rx3FxParameter(slot,"delay_time")->getValue());
    EXPECT_EQ(1,rx3FxParameter(slot,"rx3_exact_time")->getValue());
    ControlObject::set(ConfigKey("[RX3BeatFx]","xpad_hold"),0);EXPECT_EQ(0,enabled());
    ControlObject::set(ConfigKey("[RX3BeatFx]","bank_clear"),2);EXPECT_TRUE(panel.bankId(1).isEmpty());
    panel.selectEffect(effects->getBackendManager()->getManifestFromUniqueId("org.mixxx.effects.tremolo"),false);
    auto* pad=panel.findChild<WRx3XPad*>("RX3XPadSlider");
    EXPECT_TRUE(pad->cells()[0].enabled);EXPECT_TRUE(pad->cells()[4].enabled);
    panel.positionPad(4.5/8);EXPECT_NEAR(4.0/3,rx3FxParameter(slot,"rate")->getValue(),1e-9);
    panel.selectEffect(effects->getBackendManager()->getManifestFromUniqueId("org.mixxx.effects.phaser"),false);
    panel.positionPad(4.5/8);EXPECT_DOUBLE_EQ(0.75,rx3FxParameter(slot,"lfo_period")->getValue());
}

TEST_F(Rx3BeatFxTest, RenderedFilterRecallKeepsAudibleAudioAtEveryInheritedMetaPosition) {
    QWidget parent;WRx3BeatFx panel(config(),effects.get(),&parent);
    const auto filter=effects->getBackendManager()->getManifestFromUniqueId("org.mixxx.effects.filter");
    for(int sampleRate:{44100,48000,96000}) for(double meta:{0.0,0.5,1.0}) {
        load("org.mixxx.effects.echo");slot->setMetaParameter(meta,true);
        panel.selectEffect(filter,true);
        const auto audio=renderFx<FilterEffect,FilterGroupState>(slot,sampleRate,sampleRate/4,{},[sampleRate](int frame){return 0.25*std::sin(frame*2*3.141592653589793*1000/sampleRate);});
        double energy=0;for(auto value:audio) {ASSERT_TRUE(std::isfinite(value));energy+=value*value;}
        EXPECT_NEAR(std::sqrt(energy/audio.size()),0.25/std::sqrt(2.0),0.002);
    }
}

TEST_F(Rx3BeatFxTest, RenderedReverbXPadProducesWetAudioAndDecayTail) {
    QWidget parent;WRx3BeatFx panel(config(),effects.get(),&parent);
    panel.selectEffect(effects->getBackendManager()->getManifestFromUniqueId("org.mixxx.effects.reverb"),false);
    panel.positionPad(0.75);
    for(int sampleRate:{44100,48000}) {
        const auto audio=renderFx<ReverbEffect,ReverbGroupState>(slot,sampleRate,2*sampleRate,{},[sampleRate](int frame){return frame<sampleRate/5?0.25*std::sin(frame*2*3.141592653589793*1000/sampleRate):0;});
        double tail=0;for(int i=sampleRate;i<int(audio.size());++i) {ASSERT_TRUE(std::isfinite(audio[i]));tail+=audio[i]*audio[i];}
        EXPECT_GT(tail,0.01);
    }
}

TEST_F(Rx3BeatFxTest, RenderedEchoFirstRepeatMatchesExactPadTimeIncludingFourSlowBeats) {
    QWidget parent;WRx3BeatFx panel(config(),effects.get(),&parent);
    panel.selectEffect(effects->getBackendManager()->getManifestFromUniqueId("org.mixxx.effects.echo"),false);
    for(int sampleRate:{44100,48000}) for(const auto& setting:QList<QPair<double,double>>{{0.0625,120},{0.75,128},{4,40}}) {
        rx3SetFxParameter(slot,"delay_time",setting.first);
        rx3SetFxParameter(slot,"rx3_exact_time",1);rx3SetFxParameter(slot,"triplet",1);
        rx3SetFxParameter(slot,"feedback_amount",0);
        GroupFeatureState features;features.beat_length=GroupFeatureBeatLength{60/setting.second,1};
        const int delay=int(setting.first*60/setting.second*sampleRate);
        const int impulse=1024;
        const auto audio=renderFx<EchoEffect,EchoGroupState>(slot,sampleRate,delay+impulse+512,features,[](int frame){return frame==impulse?0.5:0;});
        EXPECT_NEAR(audio[2*(impulse+delay)],0.5,0.002) << setting.first << " beats @ " << setting.second;
        double before=0;for(int i=0;i<2*(impulse+delay);++i) before+=std::abs(audio[i]);
        EXPECT_LT(before,0.001);
    }
}

TEST_F(Rx3BeatFxTest, RenderedTremoloModulatesAtExactSixteenthAndThreeQuarterPeriods) {
    QWidget parent;WRx3BeatFx panel(config(),effects.get(),&parent);
    panel.selectEffect(effects->getBackendManager()->getManifestFromUniqueId("org.mixxx.effects.tremolo"),false);
    for(double beatPeriod:{0.0625,0.75}) {
        rx3SetFxParameter(slot,"rate",1/beatPeriod);rx3SetFxParameter(slot,"rx3_exact_time",1);
        rx3SetFxParameter(slot,"quantize",1);rx3SetFxParameter(slot,"triplet",1);
        GroupFeatureState features;features.beat_length=GroupFeatureBeatLength{0.5,1};
        const int sampleRate=48000,period=int(sampleRate*0.5*beatPeriod);
        const auto audio=renderFx<TremoloEffect,TremoloState>(slot,sampleRate,period*6+4096,features,[](int){return 0.5;});
        double minimum=1,maximum=0,error=0;const int start=period*4;
        for(int i=start;i<start+period;++i) {
            minimum=std::min(minimum,double(audio[2*i]));maximum=std::max(maximum,double(audio[2*i]));
            error+=std::abs(audio[2*i]-audio[2*(i+period)]);
        }
        EXPECT_GT(maximum-minimum,0.05);EXPECT_LT(error/period,0.001);
    }
}


TEST_F(Rx3BeatFxTest, EngineChainUsesManualTempoForEchoInsteadOfDeckTempo) {
    QWidget parent;WRx3BeatFx panel(config(),effects.get(),&parent);
    panel.selectEffect(effects->getBackendManager()->getManifestFromUniqueId("org.mixxx.effects.echo"),false);
    rx3SetFxParameter(slot,"delay_time",0.5);rx3SetFxParameter(slot,"rx3_exact_time",1);
    rx3SetFxParameter(slot,"feedback_amount",0);
    panel.setAmount(1);
    ControlObject::set(ConfigKey(WRx3BeatFx::unitGroup(),"group_[MasterOutput]_enable"),1);
    ControlObject::set(ConfigKey("[RX3BeatFx]","bpm_mode"),1);
    ControlObject::set(ConfigKey("[RX3BeatFx]","bpm_manual"),60);
    ControlObject::set(ConfigKey("[RX3BeatFx]","xpad_hold"),1);
    const auto handle=factory->getOrCreateHandle("[MasterOutput]");
    auto* engine=effects->getEngineEffectsManager();
    GroupFeatureState features;features.beat_length=GroupFeatureBeatLength{0.5,1}; // Deck: 120 BPM.
    mixxx::SampleBuffer buffer(512);
    std::vector<CSAMPLE> audio;
    for(int offset=0;offset<26000;offset+=256) {
        SampleUtil::clear(buffer.data(),512);
        if(offset==1024) buffer[0]=buffer[1]=0.5;
        features.beat_fraction_buffer_end=std::fmod((offset+256.0)/48000/0.5,1.0);
        engine->onCallbackStart();
        engine->processPostFaderInPlace(handle,handle,buffer.data(),512,mixxx::audio::SampleRate(48000),features);
        audio.insert(audio.end(),buffer.data(),buffer.data()+512);
    }
    // Manual 60 BPM makes 1/2 beat 500 ms; the supplied deck tempo would give 250 ms.
    EXPECT_NEAR(audio[2*(1024+24000)],0.5,0.002);
    EXPECT_NEAR(audio[2*(1024+12000)],0,0.002);
}


TEST_F(Rx3BeatFxTest, EngineChainAutoClockUsesDisplayedBpmWithoutDeckMetadata) {
    QWidget parent;WRx3BeatFx panel(config(),effects.get(),&parent);
    panel.selectEffect(effects->getBackendManager()->getManifestFromUniqueId("org.mixxx.effects.echo"),true);
    rx3SetFxParameter(slot,"delay_time",0.5);rx3SetFxParameter(slot,"rx3_exact_time",1);
    rx3SetFxParameter(slot,"feedback_amount",0);panel.setAmount(1);
    ControlObject::set(ConfigKey(WRx3BeatFx::unitGroup(),"group_[MasterOutput]_enable"),1);
    ControlObject::set(ConfigKey("[RX3BeatFx]","bpm"),120);
    const auto handle=factory->getOrCreateHandle("[MasterOutput]");
    auto* engine=effects->getEngineEffectsManager();
    mixxx::SampleBuffer buffer(512);std::vector<CSAMPLE> audio;
    for(int offset=0;offset<14000;offset+=256) {
        SampleUtil::clear(buffer.data(),512);
        if(offset==1024) buffer[0]=buffer[1]=0.5;
        engine->onCallbackStart();
        engine->processPostFaderInPlace(handle,handle,buffer.data(),512,mixxx::audio::SampleRate(48000),{});
        audio.insert(audio.end(),buffer.data(),buffer.data()+512);
    }
    EXPECT_NEAR(audio[2*(1024+12000)],0.5,0.002);
}
