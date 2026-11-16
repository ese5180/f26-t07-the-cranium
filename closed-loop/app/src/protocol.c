/* SPDX-License-Identifier: MIT */
#include "protocol.h"
#include <string.h>
uint16_t cranium_crc(const void *data, size_t length) {
    const uint8_t *bytes=data; uint16_t crc=0xffff;
    for(size_t i=0;i<length;i++) {
        crc ^= (uint16_t)bytes[i]<<8;
        for(int b=0;b<8;b++) crc=(crc&0x8000)?(uint16_t)((crc<<1)^0x1021):(uint16_t)(crc<<1);
    }
    return crc;
}
static bool decimal(const char **at,const char *end,uint32_t *value) {
    uint32_t v=0; const char *p=*at; bool any=false;
    while(p<end && *p>='0' && *p<='9') {
        uint32_t d=(uint32_t)(*p-'0');
        if(v>(UINT32_MAX-d)/10) return false;
        v=v*10+d; p++; any=true;
    }
    if(!any || p>=end || *p!=':') return false;
    *at=p+1; *value=v; return true;
}
enum cranium_result cranium_parse(const char *line,size_t n,struct cranium_frame *out) {
    memset(out,0,sizeof(*out));
    if(n<14 || n>=CRANIUM_FRAME_MAX || memcmp(line,"C1:",3)) return CRANIUM_FRAME;
    if(line[n-1]=='\n') n--;
    if(n && line[n-1]=='\r') n--;
    const char *end=line+n,*p=line+3; uint32_t length;
    if(!decimal(&p,end,&out->seq) || !decimal(&p,end,&length) || length>CRANIUM_PAYLOAD_MAX) return CRANIUM_FRAME;
    if((size_t)(end-p)!=(size_t)length+5 || p[length]!='*') return CRANIUM_FRAME;
    for(uint32_t i=0;i<length;i++) if(p[i]=='\n'||p[i]=='\r'||p[i]=='\0') return CRANIUM_FRAME;
    uint16_t expected=0;
    for(int i=1;i<=4;i++) {
        char c=p[length+i]; int digit=(c>='0'&&c<='9')?c-'0':(c>='A'&&c<='F')?c-'A'+10:(c>='a'&&c<='f')?c-'a'+10:-1;
        if(digit<0) return CRANIUM_FRAME;
        expected=(uint16_t)((expected<<4)|digit);
    }
    if(cranium_crc(line,(size_t)(p+length-line))!=expected) return CRANIUM_CRC;
    memcpy(out->payload,p,length); out->length=length;
    return CRANIUM_OK;
}
bool cranium_sequence_new(uint32_t seq,uint32_t previous,bool initialized) {
    return !initialized || (int32_t)(seq-previous)>0;
}
