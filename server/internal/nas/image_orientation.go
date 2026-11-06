package nas

import (
	"bytes"
	"encoding/binary"
)

// Read only the bounded IFD0 Orientation field, not arbitrary EXIF values.
// Source metadata is never copied to the generated image.
func imageOrientation(data []byte) int {
	if len(data) >= 2 && data[0] == 0xff && data[1] == 0xd8 {
		for pos := 2; pos+4 <= len(data); {
			if data[pos] != 0xff || data[pos+1] == 0xda || data[pos+1] == 0xd9 {
				return 1
			}
			marker := data[pos+1]
			length := int(binary.BigEndian.Uint16(data[pos+2 : pos+4]))
			if length < 2 || pos+2+length > len(data) {
				return 1
			}
			segment := data[pos+4 : pos+2+length]
			if marker == 0xe1 && bytes.HasPrefix(segment, []byte("Exif\x00\x00")) {
				return tiffOrientation(segment[6:])
			}
			pos += 2 + length
		}
		return 1
	}
	return tiffOrientation(data)
}
func tiffOrientation(data []byte) int {
	if len(data) < 8 {
		return 1
	}
	var order binary.ByteOrder
	switch string(data[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	if order.Uint16(data[2:4]) != 42 {
		return 1
	}
	offset := int64(order.Uint32(data[4:8]))
	if offset < 8 || offset+2 > int64(len(data)) {
		return 1
	}
	count := int(order.Uint16(data[offset : offset+2]))
	for i := 0; i < count; i++ {
		pos := offset + 2 + int64(i)*12
		if pos+12 > int64(len(data)) {
			return 1
		}
		entry := data[pos : pos+12]
		if order.Uint16(entry[:2]) == 0x112 && order.Uint16(entry[2:4]) == 3 && order.Uint32(entry[4:8]) == 1 {
			value := int(order.Uint16(entry[8:10]))
			if value >= 1 && value <= 8 {
				return value
			}
		}
	}
	return 1
}
