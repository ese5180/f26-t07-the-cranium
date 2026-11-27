#include <QResizeEvent>

#include "widget/openglwindow.h"
#include "widget/tooltipqopengl.h"
#include "widget/wglwidget.h"

WGLWidget::WGLWidget(QWidget* pParent)
        : QWidget(pParent),
          m_pOpenGLWindow(nullptr),
          m_pContainerWidget(nullptr),
          m_pTrackDropTarget(nullptr) {
    if(qEnvironmentVariableIsSet("CRANIUM_APPLIANCE")) {
        auto colors=palette();colors.setColor(QPalette::Window,Qt::black);
        setPalette(colors);setAutoFillBackground(true);
    }
    // When the widget is resized or moved, the QOpenGLWindow visibly resizes
    // or moves before the widgets do. This can be solved by calling
    //   setAttribute(Qt::WA_PaintOnScreen);
    // here, but this comes with a clear performance penalty and drop in
    // frame rate.
}

WGLWidget::~WGLWidget() {
    ToolTipQOpenGL::singleton().stop();
    if (m_pOpenGLWindow) {
        m_pOpenGLWindow->widgetDestroyed();
    }
}

QPaintDevice* WGLWidget::paintDevice() {
    makeCurrentIfNeeded();
    return m_pOpenGLWindow;
}

void WGLWidget::setTrackDropTarget(TrackDropTarget* pTarget) {
    m_pTrackDropTarget = pTarget;
}

TrackDropTarget* WGLWidget::trackDropTarget() const {
    return m_pTrackDropTarget;
}

void WGLWidget::showEvent(QShowEvent* event) {
    if (!m_pOpenGLWindow) {
        m_pOpenGLWindow = new OpenGLWindow(this);
        m_pContainerWidget = createWindowContainer(m_pOpenGLWindow, this);
        m_pContainerWidget->resize(size());
        // Set the backing color before mapping the native GL surface. The
        // default light Qt palette otherwise flashes while the first GL frame
        // is pending after switching from performance to a browser page.
        if(qEnvironmentVariableIsSet("CRANIUM_APPLIANCE")) {
            auto colors=m_pContainerWidget->palette();colors.setColor(QPalette::Window,Qt::black);
            m_pContainerWidget->setPalette(colors);
        }
        m_pContainerWidget->setAutoFillBackground(true);
        m_pContainerWidget->show();
    }
    QWidget::showEvent(event);
}

void WGLWidget::resizeEvent(QResizeEvent* event) {
    if (m_pContainerWidget) {
        m_pContainerWidget->resize(event->size());
    }
    QWidget::resizeEvent(event);
}

bool WGLWidget::isContextValid() const {
    return m_pOpenGLWindow && m_pOpenGLWindow->context() && m_pOpenGLWindow->context()->isValid();
}

void WGLWidget::makeCurrentIfNeeded() {
    if (m_pOpenGLWindow && m_pOpenGLWindow->context() != QOpenGLContext::currentContext()) {
        m_pOpenGLWindow->makeCurrent();
    }
}

void WGLWidget::doneCurrent() {
    if (m_pOpenGLWindow) {
        m_pOpenGLWindow->doneCurrent();
    }
}

void WGLWidget::paintGL() {
    // to be implemented in derived widgets if needed
}

void WGLWidget::initializeGL() {
    // to be implemented in derived widgets if needed
}

void WGLWidget::resizeGL(int w, int h) {
    Q_UNUSED(w);
    Q_UNUSED(h);
    // to be implemented in derived widgets if needed
}

void WGLWidget::swapBuffers() {
    if (shouldRender()) {
        m_pOpenGLWindow->context()->swapBuffers(m_pOpenGLWindow->context()->surface());
    }
}

bool WGLWidget::shouldRender() const {
    return m_pOpenGLWindow && m_pOpenGLWindow->isExposed();
}

QOpenGLWindow* WGLWidget::getOpenGLWindow() const {
    return m_pOpenGLWindow;
}
