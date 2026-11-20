#pragma once

#include <QLabel>
#include <QPointer>
#include <QStackedLayout>
#include <QTimer>
#include <array>
#include <vector>
#include "control/controlproxy.h"

// Retain the loaded track and source/time/BPM fields while hiding inaccessible
// title, grid and waveform surfaces. The same live footer serves every page.
class WRx3Emergency : public QObject {
  public:
    explicit WRx3Emergency(QWidget* canvas):QObject(canvas),m_canvas(canvas) {
        for(int deck=1;deck<=2;++deck) {
            const auto group=QString("[Channel%1]").arg(deck);
            m_lost[deck-1]=new ControlProxy(group,"rx3_source_lost",this,ControlFlag::NoAssertIfMissing);
            m_loop[deck-1]=new ControlProxy(group,"rx3_emergency_loop",this,ControlFlag::NoAssertIfMissing);
            m_lost[deck-1]->connectValueChanged(this,[this](double){refresh();});
            m_loop[deck-1]->connectValueChanged(this,[this](double){refresh();});
            wrap(canvas->findChild<QWidget*>(QString("Waveform%1").arg(deck)),deck-1,QString());
        }
        for(auto* widget:canvas->findChildren<QWidget*>()) {
            const auto name=widget->objectName();
            if(name!="DeckOverview" && name!="RX3LibraryDeckOverview" &&
                    name!="DeckTitle" && name!="WaveformInfo_Key" && name!="WaveformInfo_Bars") continue;
            int deck=0;
            for(auto* owner=widget;owner && !deck;owner=owner->parentWidget()) deck=owner->property("rx3Deck").toInt();
            if(deck<1 || deck>2) continue;
            wrap(widget,deck-1,name.endsWith("Overview")?"EMERGENCY LOOP":
                    name=="WaveformInfo_Bars"?"--.- Bars":QString());
        }
        auto* area=canvas->findChild<QWidget*>("RX3PerformanceArea");
        if(area) {
            auto* stack=qobject_cast<QStackedLayout*>(area->layout());
            auto* parent=stack && stack->count()?stack->widget(0):area;
            m_message=new QLabel("Cannot play track.\nSome player functions limited.",parent);
            m_message->setObjectName("RX3EmergencyMessage");m_message->setAlignment(Qt::AlignCenter);
            m_message->setStyleSheet("background:black;color:white;border:1px solid white;font-family:Arial;font-size:14px;");
            m_message->hide();
        }
        auto* timer=new QTimer(this);timer->setInterval(100);
        connect(timer,&QTimer::timeout,this,[this]{refresh();});timer->start();refresh();
    }
  private:
    struct Mask {QStackedLayout* stack;QLabel* label;QString text;};
    void wrap(QWidget* original,int deck,const QString& text) {
        if(!original || !original->parentWidget() || !original->parentWidget()->layout()) return;
        auto* parent=original->parentWidget();auto* replacement=new QWidget(parent);
        replacement->setObjectName(original->objectName()+"EmergencyMask");
        replacement->setSizePolicy(original->sizePolicy());
        replacement->setMinimumSize(original->minimumSize());replacement->setMaximumSize(original->maximumSize());
        replacement->setProperty("rx3DeckSelect",original->property("rx3DeckSelect"));
        auto* item=parent->layout()->replaceWidget(original,replacement);
        if(!item) {delete replacement;return;}delete item;
        auto* stack=new QStackedLayout(replacement);stack->setContentsMargins(0,0,0,0);
        stack->addWidget(original);
        auto* label=new QLabel(text,replacement);label->setAlignment(Qt::AlignCenter);
        label->setStyleSheet("background:black;color:"+QString(text=="EMERGENCY LOOP"?"#ff4000":"#ddd")+";font-family:Arial;font-size:14px;border:0;");
        stack->addWidget(label);stack->setCurrentIndex(0);
        m_masks[deck].push_back({stack,label,text});
    }
    void refresh() {
        bool any=false;
        for(int i=0;i<2;++i) {
            const bool lost=m_lost[i]->get()>0;any|=lost;
            for(const auto& mask:m_masks[i]) {
                if(mask.text=="EMERGENCY LOOP") mask.label->setText(m_loop[i]->get()>0?mask.text:"Cannot play track.");
                mask.stack->setCurrentIndex(lost?1:0);
            }
        }
        if(m_message) {
            auto* parent=m_message->parentWidget();
            const double scale=m_canvas->height()/800.0;
            const QSize size(qRound(320*scale),qRound(74*scale));
            m_message->setGeometry((parent->width()-size.width())/2,(parent->height()-size.height())/2,size.width(),size.height());
            m_message->setVisible(any);if(any) m_message->raise();
        }
    }
    QWidget* m_canvas;
    std::array<ControlProxy*,2> m_lost{},m_loop{};
    std::array<std::vector<Mask>,2> m_masks;
    QPointer<QLabel> m_message;
};
