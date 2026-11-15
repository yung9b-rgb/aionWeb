// Read-only Npcap bridge. No listen/connect/send/inject APIs. Windows x64, no SDK required.
// stdout: uint32 caplen, uint32 linktype, then frame. stderr: JSON control/status lines.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <io.h>
typedef struct pcap pcap_t;
typedef struct dev { struct dev *next; char *name, *description; void *addresses; unsigned flags; } dev;
typedef struct { unsigned len; void *insns; } bpf;
typedef struct { long sec, usec; unsigned caplen, len; } hdr;
typedef struct { unsigned recv, drop, ifdrop, capt, sent, netdrop; } stats;
#define API(ret, name, args) static ret (__cdecl *name) args
API(int, pcap_findalldevs, (dev **, char *));
API(void, pcap_freealldevs, (dev *));
API(const char *, pcap_lib_version, (void));
API(int, pcap_init, (unsigned, char *));
API(pcap_t *, pcap_create, (const char *, char *));
API(int, pcap_set_snaplen, (pcap_t *, int));
API(int, pcap_set_promisc, (pcap_t *, int));
API(int, pcap_set_timeout, (pcap_t *, int));
API(int, pcap_set_buffer_size, (pcap_t *, int));
API(int, pcap_activate, (pcap_t *));
API(int, pcap_setnonblock, (pcap_t *, int, char *));
API(int, pcap_datalink, (pcap_t *));
API(int, pcap_compile, (pcap_t *, bpf *, const char *, int, unsigned));
API(int, pcap_setfilter, (pcap_t *, bpf *));
API(void, pcap_freecode, (bpf *));
API(int, pcap_next_ex, (pcap_t *, hdr **, const unsigned char **));
API(int, pcap_stats, (pcap_t *, stats *));
API(const char *, pcap_geterr, (pcap_t *));
API(void, pcap_close, (pcap_t *));
static void jsonstr(const char *s) {
    fputc('"', stderr);
    for (; *s; s++) { unsigned char c = (unsigned char)*s;
        if(c=='"'||c=='\\') { fputc('\\',stderr); fputc(c,stderr); }
        else if(c<32) fprintf(stderr,"\\u%04x",c);
        else fputc(c,stderr);
    } fputc('"', stderr);
}
static int fail(const char *code, const char *detail) {
    fprintf(stderr,"{\"type\":\"error\",\"code\":\"%s\",\"detail\":",code);
    jsonstr(detail); fputs("}\n",stderr); return 1;
}
// Parent closure (including crash) closes stdin; do not leave a capture process behind.
static DWORD WINAPI watch_parent(void *unused) {
    (void)unused; char b; DWORD got;
    while(ReadFile(GetStdHandle(STD_INPUT_HANDLE),&b,1,&got,NULL) && got) {}
    ExitProcess(0); return 0;
}
int main(int argc, char **argv) {
    setvbuf(stderr,NULL,_IONBF,0); setvbuf(stdout,NULL,_IONBF,0); _setmode(_fileno(stdout),_O_BINARY);
    wchar_t dll[MAX_PATH]; unsigned n = GetSystemDirectoryW(dll,MAX_PATH);
    if(!n || n>MAX_PATH-24) return fail("DLL","System directory unavailable");
    wcscat(dll,L"\\Npcap\\wpcap.dll");
    HMODULE lib = LoadLibraryExW(dll,NULL,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_SYSTEM32);
    if(!lib) return fail("DLL","Install Npcap from https://npcap.com/ (64-bit runtime missing)");
#define LOAD(name) do { *(FARPROC *)&name=GetProcAddress(lib,#name); if(!name) return fail("API",#name); } while(0)
    LOAD(pcap_findalldevs); LOAD(pcap_freealldevs); LOAD(pcap_lib_version); LOAD(pcap_init); LOAD(pcap_create);
    LOAD(pcap_set_snaplen); LOAD(pcap_set_promisc); LOAD(pcap_set_timeout); LOAD(pcap_set_buffer_size);
    LOAD(pcap_activate); LOAD(pcap_setnonblock); LOAD(pcap_datalink); LOAD(pcap_compile); LOAD(pcap_setfilter);
    LOAD(pcap_freecode); LOAD(pcap_next_ex); LOAD(pcap_stats); LOAD(pcap_geterr); LOAD(pcap_close);
    if(!strstr(pcap_lib_version(),"Npcap")) return fail("DLL","Npcap is required; legacy WinPcap is unsupported");
    char err[256]={0};
    if(pcap_init(1,err)<0) return fail("INIT",err); // PCAP_CHAR_ENC_UTF_8
    if(argc==2 && strcmp(argv[1],"--list")==0) {
        dev *all=NULL;
        if(pcap_findalldevs(&all,err)<0) return fail("OPEN",err);
        fputs("{\"type\":\"devices\",\"version\":",stderr); jsonstr(pcap_lib_version()); fputs(",\"devices\":[",stderr);
        int first=1; for(dev *d=all; d; d=d->next) {
            if(!first) fputc(',',stderr); first=0;
            fputs("{\"name\":",stderr); jsonstr(d->name); fputs(",\"description\":",stderr);
            jsonstr(d->description ? d->description : d->name); fputc('}',stderr);
        } fputs("]}\n",stderr); pcap_freealldevs(all); return 0;
    }
    if(argc!=4) return fail("ARGS","device port host required");
    char *end; long port=strtol(argv[2],&end,10);
    if(*end || port<1 || port>65535) return fail("ARGS","Invalid port");
    // Host must be a numeric IPv4/IPv6 address. Never interpolate arbitrary BPF expressions.
    if(!*argv[3] || strlen(argv[3])>45 || strspn(argv[3],"0123456789abcdefABCDEF:.")!=strlen(argv[3])) return fail("ARGS","Numeric host required");
    HANDLE watcher=CreateThread(NULL,0,watch_parent,NULL,0,NULL);
    if(!watcher) return fail("PARENT","Cannot monitor parent"); CloseHandle(watcher);
    SetPriorityClass(GetCurrentProcess(),BELOW_NORMAL_PRIORITY_CLASS);
    pcap_t *p=pcap_create(argv[1],err); if(!p) return fail("OPEN",err);
    if(pcap_set_snaplen(p,262144)<0 || pcap_set_promisc(p,0)<0 || pcap_set_timeout(p,100)<0 || pcap_set_buffer_size(p,8*1024*1024)<0)
        return fail("OPEN",pcap_geterr(p));
    if(pcap_activate(p)<0 || pcap_setnonblock(p,1,err)<0) return fail("OPEN",pcap_geterr(p));
    char filter[160]; snprintf(filter,sizeof(filter),"tcp port %ld and host %s",port,argv[3]);
    bpf program={0};
    if(pcap_compile(p,&program,filter,1,0xffffffff)<0) return fail("FILTER",pcap_geterr(p));
    int filtered=pcap_setfilter(p,&program); pcap_freecode(&program);
    if(filtered<0) return fail("FILTER",pcap_geterr(p));
    int link=pcap_datalink(p);
    if(link!=0 && link!=1 && link!=12 && link!=101) return fail("LINK","Unsupported link type; select Ethernet or Npcap Loopback");
    fprintf(stderr,"{\"type\":\"ready\",\"link\":%d}\n",link);
    ULONGLONG stamp=GetTickCount64();
    for(;;) {
        hdr *h; const unsigned char *data; int rc=pcap_next_ex(p,&h,&data);
        if(rc<0) return fail("READ",pcap_geterr(p));
        if(rc==1) {
            if(h->caplen!=h->len || h->caplen>262144) return fail("TRUNCATED","Captured frame truncated; restart capture");
            uint32_t head[2]={h->caplen,(uint32_t)link};
            if(fwrite(head,1,8,stdout)!=8 || fwrite(data,1,h->caplen,stdout)!=h->caplen) break;
        } else Sleep(10);
        if(GetTickCount64()-stamp>=1000) {
            stats s={0}; if(pcap_stats(p,&s)==0) fprintf(stderr,"{\"type\":\"stats\",\"received\":%u,\"dropped\":%u}\n",s.recv,s.drop+s.ifdrop);
            stamp=GetTickCount64();
        }
    }
    pcap_close(p); return 0;
}
