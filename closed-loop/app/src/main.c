/* SPDX-License-Identifier: MIT
 * CRANIUM laboratory companion: bounded UART ingress -> NUS notifications.
 * ACK confirms validated UART receipt, never unverified radio delivery.
 */
#include <zephyr/kernel.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <bluetooth/services/nus.h>
#include <stdio.h>
#include <string.h>
#include "protocol.h"
#include "profile.h"
struct input_line { size_t length; char data[CRANIUM_FRAME_MAX]; };
K_MSGQ_DEFINE(lines,sizeof(struct input_line),4,4);
K_MSGQ_DEFINE(radio,sizeof(struct cranium_frame),4,4);
static const struct device *uart=DEVICE_DT_GET(DT_NODELABEL(uart0));
static const struct gpio_dt_spec led=GPIO_DT_SPEC_GET(DT_ALIAS(led0),gpios);
static atomic_t subscribed;
static atomic_t secured;
static struct k_work advertising;
static void send_text(const char *text) { for(size_t i=0;text[i];i++) uart_poll_out(uart,text[i]); }
static void irq(const struct device *dev,void *unused) {
    ARG_UNUSED(unused); static struct input_line current; static bool overflow;
    uint8_t c;
    if(!uart_irq_update(dev)) return;
    while(uart_irq_rx_ready(dev) && uart_fifo_read(dev,&c,1)==1) {
        if(c=='\n') {
            if(!overflow) { current.data[current.length++]='\n'; k_msgq_put(&lines,&current,K_NO_WAIT); }
            current.length=0; overflow=false;
        } else if(current.length<sizeof(current.data)-2 && !overflow) current.data[current.length++]=(char)c;
        else overflow=true;
    }
}
static void enable_notify(enum bt_nus_send_status status) { atomic_set(&subscribed,status==BT_NUS_SEND_STATUS_ENABLED); }
static struct bt_nus_cb nus_callbacks={ .send_enabled=enable_notify };
static const struct bt_data ad[]={BT_DATA_BYTES(BT_DATA_FLAGS,BT_LE_AD_GENERAL|BT_LE_AD_NO_BREDR),BT_DATA(BT_DATA_NAME_COMPLETE,CONFIG_BT_DEVICE_NAME,sizeof(CONFIG_BT_DEVICE_NAME)-1)};
static const struct bt_data sd[]={BT_DATA_BYTES(BT_DATA_UUID128_ALL,BT_UUID_NUS_VAL)};
static void advertise(struct k_work *work) {
    ARG_UNUSED(work);
    struct bt_le_adv_param params=BT_LE_ADV_PARAM_INIT(BT_LE_ADV_OPT_CONN,CRANIUM_ADV_UNITS,CRANIUM_ADV_UNITS+16,NULL);
    bt_le_adv_start(&params,ad,ARRAY_SIZE(ad),sd,ARRAY_SIZE(sd));
}
static void disconnected(struct bt_conn *conn,uint8_t reason) {
    ARG_UNUSED(conn); ARG_UNUSED(reason); atomic_clear(&subscribed); atomic_clear(&secured); k_work_submit(&advertising);
}
static void connected(struct bt_conn *conn,uint8_t error) {
    if(!error) bt_conn_set_security(conn,BT_SECURITY_L2);
}
static void security_changed(struct bt_conn *conn,bt_security_t level,enum bt_security_err error) {
    ARG_UNUSED(conn); atomic_set(&secured,!error && level>=BT_SECURITY_L2);
}
BT_CONN_CB_DEFINE(connection_callbacks)={ .connected=connected,.disconnected=disconnected,.security_changed=security_changed };
static void transmit(void *a,void *b,void *c) {
    ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c); struct cranium_frame frame;
    while(true) {
        k_msgq_get(&radio,&frame,K_FOREVER);
        if(!atomic_get(&subscribed) || !atomic_get(&secured)) continue;
        frame.payload[frame.length++]='\n';
        for(size_t offset=0;offset<frame.length;) {
            size_t n=MIN((size_t)20,frame.length-offset); int rc=-1;
            for(int tries=0;tries<5;tries++) {
                rc=bt_nus_send(NULL,(const uint8_t *)frame.payload+offset,n);
                if(!rc) break;
                k_msleep(10);
            }
            if(rc) break;
            offset+=n;
        }
    }
}
K_THREAD_DEFINE(radio_thread,2048,transmit,NULL,NULL,NULL,7,0,0);
int main(void) {
    if(!device_is_ready(uart)) return 1;
    if(!gpio_is_ready_dt(&led)) return 2;
    gpio_pin_configure_dt(&led,GPIO_OUTPUT_INACTIVE);
    k_work_init(&advertising,advertise);
    if(bt_enable(NULL) || bt_nus_init(&nus_callbacks)) return 3;
    k_work_submit(&advertising);
    uart_irq_callback_user_data_set(uart,irq,NULL); uart_irq_rx_enable(uart);
    send_text("CRANIUM:READY:" CRANIUM_PROFILE "\n");
    struct input_line line; uint32_t previous=0; bool initialized=false,light=false;
    while(true) {
        int ready=k_msgq_get(&lines,&line,CRANIUM_HEARTBEAT_MS?K_MSEC(CRANIUM_HEARTBEAT_MS):K_FOREVER);
        if(CRANIUM_STATUS_LED) { light=!light; gpio_pin_set_dt(&led,light); }
        if(ready) continue;
        struct cranium_frame frame; enum cranium_result result=cranium_parse(line.data,line.length,&frame);
        if(result==CRANIUM_OK && !cranium_sequence_new(frame.seq,previous,initialized)) result=CRANIUM_DUP;
        if(result==CRANIUM_OK) { previous=frame.seq; initialized=true; }
        const char *status=result==CRANIUM_OK?"OK":result==CRANIUM_CRC?"CRC":result==CRANIUM_DUP?"DUP":"FRAME";
        bool queued=result==CRANIUM_OK && atomic_get(&subscribed) && atomic_get(&secured) && !k_msgq_put(&radio,&frame,K_NO_WAIT);
        char reply[72]; snprintf(reply,sizeof(reply),"ACK:%u:%s:%u\n",frame.seq,status,queued?1:0); send_text(reply);
    }
}
