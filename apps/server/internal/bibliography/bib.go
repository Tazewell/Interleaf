// Package bibliography parses BibTeX as data. Field expressions are retained so
// unknown fields and TeX capitalization/commands survive a round trip.
package bibliography

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

type Field struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}
type Entry struct {
	Type   string  `json:"type"`
	Key    string  `json:"key"`
	Fields []Field `json:"fields"`
}
type Database struct {
	Entries   []Entry  `json:"entries"`
	Strings   []Field  `json:"strings,omitempty"`
	Preambles []string `json:"preambles,omitempty"`
}

type parser struct {
	src string
	pos int
}

func (p *parser) failure(message string) error {
	before := p.src[:p.pos]
	line := strings.Count(before, "\n") + 1
	column := utf8.RuneCountInString(before[strings.LastIndex(before, "\n")+1:]) + 1
	return fmt.Errorf("第 %d 行，第 %d 列：%s", line, column, message)
}
func (p *parser) skip() {
	for p.pos < len(p.src) {
		if p.src[p.pos] == '%' {
			for p.pos < len(p.src) && p.src[p.pos] != '\n' {
				p.pos++
			}
			continue
		}
		if !strings.ContainsRune(" \t\r\n", rune(p.src[p.pos])) {
			break
		}
		p.pos++
	}
}
func (p *parser) take(c byte) bool {
	p.skip()
	if p.pos < len(p.src) && p.src[p.pos] == c {
		p.pos++
		return true
	}
	return false
}

var namePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_:\-.]*$`)

func (p *parser) name() string {
	p.skip()
	start := p.pos
	for p.pos < len(p.src) && strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_:-.", rune(p.src[p.pos])) {
		p.pos++
	}
	return strings.ToLower(p.src[start:p.pos])
}
func (p *parser) atom() (string, error) {
	p.skip()
	start := p.pos
	if p.pos >= len(p.src) {
		return "", p.failure("缺少字段值")
	}
	first := p.src[p.pos]
	if first == '{' || first == '"' {
		p.pos++
		depth := 0
		if first == '{' {
			depth = 1
		}
		for p.pos < len(p.src) {
			c := p.src[p.pos]
			p.pos++
			if c == '\\' {
				if p.pos < len(p.src) {
					p.pos++
				}
				continue
			}
			if c == '{' {
				depth++
				if depth > 128 {
					return "", p.failure("花括号嵌套过深")
				}
			}
			if c == '}' {
				depth--
				if first == '{' && depth == 0 {
					return p.src[start:p.pos], nil
				}
				if depth < 0 {
					return "", p.failure("字段值花括号不匹配")
				}
			}
			if c == '"' && first == '"' && depth == 0 {
				return p.src[start:p.pos], nil
			}
		}
		return "", p.failure("字段值未闭合")
	}
	for p.pos < len(p.src) && !strings.ContainsRune(" \t\r\n,#{}()\"%", rune(p.src[p.pos])) {
		p.pos++
	}
	if p.pos == start {
		return "", p.failure("缺少字段值")
	}
	return p.src[start:p.pos], nil
}
func (p *parser) expression() (string, error) {
	var parts []string
	for {
		part, err := p.atom()
		if err != nil {
			return "", err
		}
		parts = append(parts, part)
		if !p.take('#') {
			break
		}
	}
	return strings.Join(parts, " # "), nil
}

func Parse(text string) (Database, error) {
	db := Database{Entries: []Entry{}}
	p := parser{src: strings.TrimPrefix(text, "\ufeff")}
	macroPositions := map[string]int{}
	if len(text) > 8<<20 {
		return db, p.failure("参考文献文件超过 8 MiB")
	}
	for {
		p.skip()
		if p.pos == len(p.src) {
			break
		}
		// BibTeX allows prose/comments outside records.
		if p.src[p.pos] != '@' {
			p.pos++
			continue
		}
		p.pos++
		kind := p.name()
		if !namePattern.MatchString(kind) {
			return db, p.failure("无效的条目类型")
		}
		p.skip()
		close := byte('}')
		if p.take('(') {
			close = ')'
		} else if !p.take('{') {
			return db, p.failure("条目缺少开始括号")
		}
		if kind == "comment" {
			depth := 1
			for p.pos < len(p.src) && depth > 0 {
				c := p.src[p.pos]
				p.pos++
				if c == '\\' && p.pos < len(p.src) {
					p.pos++
					continue
				}
				if c == close {
					depth--
				} else if (close == '}' && c == '{') || (close == ')' && c == '(') {
					depth++
				}
				if depth > 128 {
					return db, p.failure("注释嵌套过深")
				}
			}
			if depth != 0 {
				return db, p.failure("注释未闭合")
			}
			continue
		}
		if kind == "preamble" {
			value, err := p.expression()
			if err != nil {
				return db, err
			}
			db.Preambles = append(db.Preambles, value)
			p.take(',')
			if !p.take(close) {
				return db, p.failure("前导内容缺少结束括号")
			}
			continue
		}
		if kind == "string" {
			position := p.pos
			name := p.name()
			for _, old := range db.Strings {
				if old.Name == name {
					return db, p.failure("字符串宏重复定义：" + name)
				}
			}
			if !namePattern.MatchString(name) || !p.take('=') {
				return db, p.failure("无效的字符串宏")
			}
			value, err := p.expression()
			if err != nil {
				return db, err
			}
			db.Strings = append(db.Strings, Field{name, value})
			macroPositions[name] = position
			p.take(',')
			if !p.take(close) {
				return db, p.failure("字符串宏缺少结束括号")
			}
			continue
		}
		p.skip()
		start := p.pos
		for p.pos < len(p.src) && p.src[p.pos] != ',' && p.src[p.pos] != close {
			p.pos++
		}
		key := strings.TrimSpace(p.src[start:p.pos])
		if key == "" || strings.ContainsAny(key, "{}()\"#%") || strings.IndexFunc(key, unicode.IsSpace) >= 0 {
			return db, p.failure("无效的引用键")
		}
		entry := Entry{Type: kind, Key: key, Fields: []Field{}}
		if p.take(close) {
			db.Entries = append(db.Entries, entry)
			continue
		}
		if !p.take(',') {
			return db, p.failure("引用键后缺少逗号")
		}
		seen := map[string]bool{}
		for !p.take(close) {
			name := p.name()
			if !namePattern.MatchString(name) || seen[name] || !p.take('=') {
				return db, p.failure("无效、重复或缺少等号的字段")
			}
			seen[name] = true
			value, err := p.expression()
			if err != nil {
				return db, err
			}
			entry.Fields = append(entry.Fields, Field{name, value})
			if p.take(close) {
				break
			}
			if !p.take(',') {
				return db, p.failure("字段后缺少逗号或结束括号")
			}
		}
		db.Entries = append(db.Entries, entry)
	}
	// Reject cycles even when the offending macro is not used by an entry.
	macros := db.macros()
	for _, f := range db.Strings {
		value, err := db.resolve(f.Name, macros, map[string]bool{}, true)
		if err != nil {
			return db, p.failure(err.Error())
		}
		for _, month := range months {
			if f.Name == strings.ToLower(month[:3]) && !strings.EqualFold(strings.TrimSpace(value), month) {
				location := parser{src: p.src, pos: macroPositions[f.Name]}
				return db, location.failure("不能更改内置月份宏的含义：" + f.Name)
			}
		}
	}
	return db, nil
}

var months = []string{"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"}

func (db Database) macros() map[string]string {
	m := map[string]string{}
	for _, month := range months {
		m[strings.ToLower(month[:3])] = "{" + month + "}"
	}
	for _, f := range db.Strings {
		m[strings.ToLower(f.Name)] = f.Value
	}
	return m
}
func (db Database) resolve(expression string, macros map[string]string, visiting map[string]bool, allowUnknown bool) (string, error) {
	budget := 16384
	return db.resolveBounded(expression, macros, visiting, allowUnknown, &budget)
}

func (db Database) resolveBounded(expression string, macros map[string]string, visiting map[string]bool, allowUnknown bool, budget *int) (string, error) {
	p := parser{src: expression}
	var result strings.Builder
	for {
		*budget--
		if *budget < 0 {
			return "", fmt.Errorf("字符串宏展开次数过多")
		}
		part, err := p.atom()
		if err != nil {
			return "", err
		}
		var value string
		if part[0] == '{' || part[0] == '"' {
			value = part[1 : len(part)-1]
		} else if strings.IndexFunc(part, func(r rune) bool { return r < '0' || r > '9' }) < 0 {
			value = part
		} else {
			name := strings.ToLower(part)
			if visiting[name] {
				return "", fmt.Errorf("字符串宏循环引用：%s", name)
			}
			expr, ok := macros[name]
			if !ok {
				if allowUnknown {
					value = part
				} else {
					return "", fmt.Errorf("未定义的字符串宏：%s", part)
				}
			} else {
				if len(visiting) >= 128 {
					return "", fmt.Errorf("字符串宏嵌套过深")
				}
				visiting[name] = true
				value, err = db.resolveBounded(expr, macros, visiting, allowUnknown, budget)
				delete(visiting, name)
				if err != nil {
					return "", err
				}
			}
		}
		if result.Len()+len(value) > 1<<20 {
			return "", fmt.Errorf("展开后的字段超过 1 MiB")
		}
		result.WriteString(value)
		if !p.take('#') {
			p.skip()
			if p.pos != len(p.src) {
				return "", p.failure("字段表达式包含额外内容")
			}
			break
		}
	}
	return result.String(), nil
}

// Value resolves a field's string expression while preserving its TeX markup.
func (db Database) Value(entry Entry, name string) (string, error) {
	for _, field := range entry.Fields {
		if strings.EqualFold(field.Name, name) {
			return db.resolve(field.Value, db.macros(), map[string]bool{}, false)
		}
	}
	return "", nil
}

// Render writes preserved expressions and validates the resulting document.
func Render(db Database) (string, error) {
	var out strings.Builder
	ordered, err := db.orderedStrings()
	if err != nil {
		return "", err
	}
	for _, f := range ordered {
		fmt.Fprintf(&out, "@string{%s = %s}\n", f.Name, f.Value)
	}
	for _, value := range db.Preambles {
		fmt.Fprintf(&out, "@preamble{%s}\n", value)
	}
	if out.Len() > 0 {
		out.WriteByte('\n')
	}
	for _, entry := range db.Entries {
		fmt.Fprintf(&out, "@%s{%s", entry.Type, entry.Key)
		for _, field := range entry.Fields {
			fmt.Fprintf(&out, ",\n  %s = %s", field.Name, field.Value)
		}
		out.WriteString("\n}\n\n")
	}
	text := out.String()
	if _, err := Parse(text); err != nil {
		return "", err
	}
	return text, nil
}

// Classic BibTeX evaluates @string declarations in source order. Resolve our
// accepted forward references by emitting dependencies first, without rewriting
// any expression or TeX literal.
func (db Database) orderedStrings() ([]Field, error) {
	fields := map[string]Field{}
	for _, f := range db.Strings {
		fields[strings.ToLower(f.Name)] = f
	}
	state := map[string]int{}
	out := []Field{}
	var visit func(string) error
	visit = func(name string) error {
		if state[name] == 2 {
			return nil
		}
		if state[name] == 1 {
			return fmt.Errorf("字符串宏循环引用：%s", name)
		}
		f, exists := fields[name]
		if !exists {
			return nil
		}
		state[name] = 1
		if _, err := db.resolve(f.Name, db.macros(), map[string]bool{}, false); err != nil {
			return err
		}
		p := parser{src: f.Value}
		for {
			atom, err := p.atom()
			if err != nil {
				return err
			}
			if atom[0] != '{' && atom[0] != '"' {
				if err = visit(strings.ToLower(atom)); err != nil {
					return err
				}
			}
			if !p.take('#') {
				break
			}
		}
		state[name] = 2
		out = append(out, f)
		return nil
	}
	for _, f := range db.Strings {
		if err := visit(strings.ToLower(f.Name)); err != nil {
			return nil, err
		}
	}
	return out, nil
}
