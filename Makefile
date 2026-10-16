UUID     = desktop-launcher@oezcan.me
SRC      = $(CURDIR)/$(UUID)
EXTDIR   = $(HOME)/.local/share/gnome-shell/extensions
TARGET   = $(EXTDIR)/$(UUID)

.PHONY: all schemas install uninstall link zip nested enable disable

all: schemas

schemas:
	glib-compile-schemas $(SRC)/schemas/

# Development: symlink the source tree into the extensions directory.
link: schemas
	mkdir -p $(EXTDIR)
	rm -rf $(TARGET)
	ln -s $(SRC) $(TARGET)

# Plain copy install (what `gnome-extensions install` would do).
install: zip
	gnome-extensions install --force $(UUID).shell-extension.zip

uninstall:
	gnome-extensions uninstall $(UUID) || rm -rf $(TARGET)

# Build the zip for extensions.gnome.org / `gnome-extensions install`.
# `pack` includes extension.js, prefs.js, metadata.json and stylesheet.css
# and compiles the schema itself, so gschemas.compiled is not shipped.
zip:
	gnome-extensions pack --force --out-dir=$(CURDIR) \
		--schema=$(SRC)/schemas/org.gnome.shell.extensions.desktop-launcher.gschema.xml \
		$(SRC)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# Run a nested GNOME Shell for testing (Wayland). Uses its own dconf profile
# so your real session settings are untouched.
nested: link
	./scripts/nested.sh
