#pragma once

#include <QLabel>
#include <QListWidget>
#include <QPushButton>
#include <QStyle>
#include <QVBoxLayout>
#include <functional>
#include <vector>
#include <algorithm>

// Every action has the same encoder contract, irrespective of controller:
// turn selects, press executes/starts editing, turn edits, press finishes.
// Back exits editing first, then returns one level. Callbacks are copied before
// invocation because an action may replace its own menu.
class WRx3ToolMenu : public QWidget {
  public:
    struct Action {
        std::function<QString()> label;
        std::function<void()> execute;
        std::function<void(int)> adjust;
        std::function<void(bool)> editState{};
    };
    explicit WRx3ToolMenu(QWidget* parent) : QWidget(parent) {
        setObjectName("RX3BrowserTools");
        setStyleSheet("#RX3BrowserTools {background:#202020;color:white;} #RX3BrowserTools QLabel {color:white;font-family:Arial;font-size:16px;} #RX3BrowserTools QListWidget {background:#202020;color:white;border:0;font-family:Arial;font-size:16px;} #RX3BrowserTools QPushButton {background:#202020;color:white;border:1px solid white;min-height:36px;} #RX3ToolsBack[encoderFocus=\"true\"] {background:#007CE0;color:white;}");
        auto* layout=new QVBoxLayout(this);
        m_title=new QLabel(this);layout->addWidget(m_title);
        m_list=new QListWidget(this);m_list->setObjectName("RX3ToolsActions");
        m_list->setAlternatingRowColors(true);
        m_list->setStyleSheet("QListWidget {background:#000;alternate-background-color:#262626;} QListWidget::item {min-height:40px;border:0;} QListWidget::item:selected {background:#007CE0;color:white;}");
        layout->addWidget(m_list,1);
        m_status=new QLabel(this);m_status->setObjectName("RX3ToolsStatus");m_status->setWordWrap(true);layout->addWidget(m_status);
        m_backButton=new QPushButton("BACK",this);m_backButton->setObjectName("RX3ToolsBack");layout->addWidget(m_backButton);
        connect(m_backButton,&QPushButton::clicked,this,[this]{goBack();});
        connect(m_list,&QListWidget::itemClicked,this,[this]{if(m_editing && m_list->currentRow()!=m_editRow) finishEditing();setFocusIndex(m_list->currentRow());enter();});
    }
    void showMenu(QString title,std::vector<Action> actions,std::function<void()> back) {
        finishEditing();
        m_actions=std::move(actions);m_back=std::move(back);m_editing=false;
        m_title->setText(std::move(title));m_list->clear();
        for (const auto& action:m_actions) m_list->addItem(action.label());
        setFocusIndex(0);
        message("Turn to select · Press to open or edit · Hold to go back");
    }
    void move(int delta) {
        const int row=m_backFocused?int(m_actions.size()):m_list->currentRow();
        if (row<0) return;
        if (m_editing) {const auto adjust=m_actions[row].adjust;if(adjust) adjust(delta);refresh();}
        else setFocusIndex(std::clamp(row+delta,0,int(m_actions.size())));
    }
    void enter() {
        if(m_backFocused) {goBack();return;}
        const int row=m_list->currentRow();if (row<0 || row>=int(m_actions.size())) return;
        if (m_actions[row].adjust) {
            m_editing=!m_editing;
            m_editRow = m_editing ? row : -1;
            const auto state=m_actions[row].editState;if(state) state(m_editing);
            message(m_editing?"Turn to change · Press to finish":"Value set · Turn to select");
        } else {const auto execute=m_actions[row].execute;if(execute) execute();}
        refresh();
    }
    void goBack() {
        if(m_editing) {finishEditing();message("Value set · Turn to select");return;}
        const auto back=m_back;if(back) back();
    }
    void message(const QString& text) {m_status->setText(text);}
    void refresh() {for(int i=0;i<int(m_actions.size());++i) if(auto* item=m_list->item(i)) item->setText(m_actions[i].label());}
  protected:
    void hideEvent(QHideEvent* event) override {finishEditing(); QWidget::hideEvent(event);}
  private:
    void setFocusIndex(int index) {
        m_backFocused=index==int(m_actions.size());
        m_list->setCurrentRow(m_backFocused?-1:index);
        if(m_backFocused) m_list->clearSelection();
        m_backButton->setProperty("encoderFocus",m_backFocused);
        m_backButton->style()->unpolish(m_backButton);m_backButton->style()->polish(m_backButton);m_backButton->update();
    }
    void finishEditing() {
        if (!m_editing) return;
        const auto state=m_editRow>=0 && m_editRow<int(m_actions.size()) ? m_actions[m_editRow].editState : std::function<void(bool)>();
        m_editing=false;m_editRow=-1;if(state) state(false);
    }
    int m_editRow=-1;
    QLabel* m_title;
    QLabel* m_status;
    QListWidget* m_list;
    QPushButton* m_backButton;
    std::vector<Action> m_actions;
    std::function<void()> m_back;
    bool m_editing=false;
    bool m_backFocused=false;
};
