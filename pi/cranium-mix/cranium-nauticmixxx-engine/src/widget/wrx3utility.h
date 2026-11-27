#pragma once

#include <QComboBox>
#include <QHeaderView>
#include <QLabel>
#include <QPainter>
#include <QKeyEvent>
#include <QPushButton>
#include <QStyle>
#include <QTableWidget>
#include <QTimer>
#include <QVBoxLayout>
#include <algorithm>
#include <functional>
#include <vector>

// A setting is read from its owner, not copied into a second settings store.
// Turning while editing previews a choice; enter commits, back cancels.
class Rx3UtilityTable : public QTableWidget {
  public:
    using QTableWidget::QTableWidget;
  protected:
    void paintEvent(QPaintEvent* event) override {
        QTableWidget::paintEvent(event);
        QPainter painter(viewport());painter.setPen(QColor("#777777"));
        const int divider=columnViewportPosition(1)-1;
        painter.drawLine(divider,0,divider,viewport()->height());
    }
};

class WRx3Utility : public QWidget {
  public:
    struct Setting {
        QString category, name;
        QStringList choices;
        std::function<QString()> value;
        std::function<int()> selected;
        std::function<bool(int)> apply;
        QString explanation;
        std::function<void()> execute{};
    };
    explicit WRx3Utility(QWidget* parent) : QWidget(parent) {
        setObjectName("RX3Utility");
        setStyleSheet("#RX3Utility {background:#202020;color:white;} "
                "#RX3Utility QTableWidget {background:#000;alternate-background-color:#262626;color:white;border:0;font:16px Arial;} "
                "#RX3Utility QTableWidget::item {padding:8px;border:0;} "
                "#RX3Utility QTableWidget::item:selected {background:#007CE0;color:white;} "
                "#RX3Utility QComboBox {background:#007CE0;color:white;border:1px solid white;padding:6px;font:16px Arial;} "
                "#RX3Utility QComboBox QAbstractItemView {background:#202020;color:white;selection-background-color:#007CE0;} "
                "#RX3Utility QLabel {color:white;font:14px Arial;} "
                "#RX3Utility QPushButton {background:#202020;color:white;border:1px solid #aaa;min-height:36px;} "
                "#RX3UtilityBack[encoderFocus=\"true\"] {background:#007CE0;}");
        auto* layout = new QVBoxLayout(this);
        layout->setContentsMargins(0,0,0,8);
        m_table = new Rx3UtilityTable(this);
        m_table->setObjectName("RX3UtilitySettings");
        m_table->setColumnCount(2);
        m_table->horizontalHeader()->hide();m_table->verticalHeader()->hide();
        m_table->horizontalHeader()->setSectionResizeMode(0,QHeaderView::Fixed);
        m_table->horizontalHeader()->setSectionResizeMode(1,QHeaderView::Stretch);
        m_table->setShowGrid(false);m_table->setAlternatingRowColors(true);
        m_table->setSelectionMode(QAbstractItemView::SingleSelection);
        m_table->setSelectionBehavior(QAbstractItemView::SelectRows);
        m_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
        m_table->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        m_table->setVerticalScrollMode(QAbstractItemView::ScrollPerItem);
        m_table->installEventFilter(this);
        layout->addWidget(m_table,1);
        m_status = new QLabel(this);m_status->setObjectName("RX3UtilityStatus");
        m_status->setWordWrap(true);layout->addWidget(m_status);
        m_back = new QPushButton("BACK",this);m_back->setObjectName("RX3UtilityBack");
        layout->addWidget(m_back);
        connect(m_back,&QPushButton::clicked,this,[this]{back();});
        connect(m_table,&QTableWidget::cellClicked,this,[this](int row,int){
            const int index=m_settingRows.indexOf(row);
            if(index<0) return;
            if(m_editor) cancel();
            focus(index);enter();
        });
        auto* timer = new QTimer(this);timer->setInterval(150);
        connect(timer,&QTimer::timeout,this,[this]{if(isVisible()) refresh();});timer->start();
    }
    void present(std::vector<Setting> settings,std::function<void()> close) {
        cancel();m_settings=std::move(settings);m_close=std::move(close);
        m_table->clear();m_table->setRowCount(0);m_settingRows.clear();
        QString category;
        for(const auto& setting:m_settings) {
            if(category!=setting.category) {
                category=setting.category;const int row=m_table->rowCount();
                m_table->insertRow(row);
                auto* header=new QTableWidgetItem(category);
                header->setFlags(Qt::ItemIsEnabled);header->setBackground(QColor("#303030"));
                auto font=header->font();font.setBold(true);header->setFont(font);
                m_table->setItem(row,0,header);m_table->setSpan(row,0,1,2);
                m_table->setRowHeight(row,34);
            }
            const int row=m_table->rowCount();m_table->insertRow(row);
            m_settingRows.push_back(row);
            m_table->setItem(row,0,new QTableWidgetItem(setting.name));
            m_table->setItem(row,1,new QTableWidgetItem);
            m_table->setRowHeight(row,42);
        }
        focus(0);refresh();m_table->scrollToTop();
    }
    void move(int ticks) {
        if(m_editor) m_editor->setCurrentIndex(std::clamp(m_editor->currentIndex()+ticks,0,m_editor->count()-1));
        else focus(std::clamp(m_focus+ticks,0,int(m_settings.size())));
    }
    void message(const QString& text) {m_status->setText(text);}
    void enter() {
        if(m_editor) {commit();return;}
        if(m_focus==int(m_settings.size())) {back();return;}
        if(m_focus<0 || m_focus>=int(m_settings.size())) return;
        const auto& setting=m_settings[m_focus];
        if(setting.execute) {const auto execute=setting.execute;execute();return;}
        if(!setting.apply || setting.choices.isEmpty()) {
            m_status->setText(setting.explanation);return;
        }
        m_editor=new QComboBox(m_table);m_editor->addItems(setting.choices);
        m_editor->setCurrentIndex(qBound(0,setting.selected(),int(setting.choices.size())-1));
        m_table->setCellWidget(m_settingRows[m_focus],1,m_editor);
        connect(m_editor,qOverload<int>(&QComboBox::activated),this,[this]{commit();});
        m_status->setText("Turn to change · Press to apply · BACK cancels");
    }
    void back() {
        if(m_editor) {cancel();focus(m_focus);return;}
        const auto close=m_close;if(close) close();
    }
    void refresh() {
        for(int i=0;i<int(m_settings.size());++i) {
            const auto& setting=m_settings[i];
            auto* item=m_table->item(m_settingRows[i],1);
            item->setText(setting.value?setting.value():"UNAVAILABLE");
            item->setToolTip(setting.explanation);
            item->setForeground(setting.apply || setting.execute?QColor(Qt::white):QColor("#aaa"));
        }
    }
  protected:
    bool eventFilter(QObject* object,QEvent* event) override {
        if(object==m_table && event->type()==QEvent::KeyPress) {
            const int key=static_cast<QKeyEvent*>(event)->key();
            if(key==Qt::Key_Up || key==Qt::Key_Down) {move(key==Qt::Key_Up?-1:1);return true;}
            if(key==Qt::Key_Return || key==Qt::Key_Enter) {enter();return true;}
            if(key==Qt::Key_Escape || key==Qt::Key_Left) {back();return true;}
        }
        return QWidget::eventFilter(object,event);
    }
    void resizeEvent(QResizeEvent* event) override {
        QWidget::resizeEvent(event);m_table->setColumnWidth(0,qRound(width()*0.60));
    }
    void hideEvent(QHideEvent* event) override {cancel();QWidget::hideEvent(event);}
  private:
    void focus(int index) {
        m_focus=index;const bool atBack=index==int(m_settings.size());
        m_table->clearSelection();
        if(!atBack && index>=0) {
            const int row=m_settingRows[index];m_table->selectRow(row);
            m_table->scrollToItem(m_table->item(row,0));
            m_status->setText(m_settings[index].explanation.isEmpty()?
                    (m_settings[index].execute?"Turn to select · Press to open":"Turn to select · Press to choose a value"):m_settings[index].explanation);
        } else m_status->setText("Press to return");
        m_back->setProperty("encoderFocus",atBack);
        m_back->style()->unpolish(m_back);m_back->style()->polish(m_back);m_back->update();
    }
    void cancel() {
        if(!m_editor) return;
        m_table->removeCellWidget(m_settingRows[m_focus],1);m_editor=nullptr;refresh();
    }
    void commit() {
        const int choice=m_editor->currentIndex();const auto apply=m_settings[m_focus].apply;
        cancel();const bool applied=apply && apply(choice);refresh();
        m_status->setText(applied?(m_settings[m_focus].explanation.isEmpty()?QString("Value applied · Turn to select"):
                "Value applied · "+m_settings[m_focus].explanation):QString("Setting unavailable · No value applied"));
    }
    QTableWidget* m_table;
    QLabel* m_status;
    QPushButton* m_back;
    QComboBox* m_editor=nullptr;
    QList<int> m_settingRows;
    std::vector<Setting> m_settings;
    std::function<void()> m_close;
    int m_focus=0;
};
