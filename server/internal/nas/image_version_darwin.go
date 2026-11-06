package nas

import (
	"fmt"
	"os"
	"syscall"
)

func imageVersion(name string, info os.FileInfo) string {
	stat := info.Sys().(*syscall.Stat_t)
	return imageHash([]byte(fmt.Sprintf("iiif-v1:%s:%d:%d:%d:%d:%d:%d", name, stat.Dev, stat.Ino, info.Size(), info.ModTime().UnixNano(), stat.Ctimespec.Sec, stat.Ctimespec.Nsec)))
}
