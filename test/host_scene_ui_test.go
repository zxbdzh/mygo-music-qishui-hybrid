package app

import (
	"encoding/json"
	"image"
	"image/color"
	"image/draw"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo/ui"
	"mygo-music/internal/music"
)

type qishuiSceneFixtures struct {
	Pages    map[string]*music.Browse `json:"pages"`
	Covers   map[string]string        `json:"covers"`
	Stations []music.Station          `json:"stations"`
	Tracks   []music.Track            `json:"tracks"`
}

func loadQishuiSceneFixtures(t *testing.T) qishuiSceneFixtures {
	t.Helper()
	name := os.Getenv("QISHUI_SCENE_FIXTURE")
	if name == "" {
		t.Skip("QISHUI_SCENE_FIXTURE is not set")
	}
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	var f qishuiSceneFixtures
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f
}
func qishuiSceneApp(t *testing.T, fixture qishuiSceneFixtures) *app {
	t.Helper()
	a := newTestApp()
	without(a, "isLiked")
	a.account = &music.Account{ID: "synthetic-preview"}
	fake(a).info.Name = "汽水音乐"
	fake(a).info.Navigation = []music.NavItem{{Title: "首页", Builtin: "home"}, {Title: "推荐", Builtin: "stations", Icon: "star"}, {Title: "听歌模式", Page: "listening-modes", Icon: "radio"}}
	a.stations, a.stationsOnce = fixture.Stations, true
	for url, name := range fixture.Covers {
		// Offline checks use test pixels. Optional public-image checks read
		// temporary downloads, never images from an installed plugin package.
		var img image.Image = &image.Uniform{C: color.RGBA{R: 52, G: 103, B: 137, A: 255}}
		bounds := image.Rect(0, 0, 320, 320)
		if name != "" {
			if filepath.Base(name) != name {
				t.Fatal("fixture image must be in its temporary directory")
			}
			file, err := os.Open(filepath.Join(filepath.Dir(os.Getenv("QISHUI_SCENE_FIXTURE")), name))
			if err != nil {
				t.Fatal(err)
			}
			img, _, err = image.Decode(file)
			file.Close()
			if err != nil {
				t.Fatal(err)
			}
			bounds = img.Bounds()
		}
		bitmap := image.NewRGBA(bounds)
		draw.Draw(bitmap, bitmap.Bounds(), img, bounds.Min, draw.Src)
		giveCover(a, url, bitmap)
	}
	return a
}

// Native frames show remote-cover fixtures, missing-cover defaults and the stock radio without touching installed application data.
func TestQishui105NativeFrames(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	dir := framesDir(t)
	for _, view := range []struct{ id, file string }{{"listening-modes", "modes"}, {"listening-modes:more:1", "exploration"}, {"scene-modes", "all-modes"}, {"recommendations", "recommendations"}} {
		for _, dark := range []bool{false, true} {
			a := qishuiSceneApp(t, fixture)
			if view.id == "recommendations" {
				a.route = route{page: pageStations, src: "fake"}
				a.pl.Cue(sourced(fixture.Tracks...))
				a.pl.AttachRadio(radioName("fake", &a.stations[0]), func(func([]music.Track)) {})
			} else {
				a.browses = map[string]*browseData{view.id: {page: fixture.Pages[view.id]}}
				a.route = route{page: pageBrowse, src: "fake", id: view.id}
			}
			var ch chan func()
			var asked chan string
			if view.id == "listening-modes" {
				// The row asks for the batch after it as its last page shows,
				// which the view is first built with.
				ch, asked = posts(a), make(chan string, 4)
				fake(a).browse = func(id string) (*music.Browse, error) {
					asked <- id
					return fixture.Pages[id], nil
				}
			}
			tt := ui.NewTester(a.view, 1200, 900)
			tt.SetDark(dark)
			settled(tt)
			theme := "light"
			if dark {
				theme = "dark"
			}
			saveFrame(t, dir, view.file+"-"+theme+".png", tt.Image())
			if view.id == "listening-modes" {
				// The frame after the turn shows the pages go on with it.
				wait(t, asked, "the batch after the last page")
				runPost(t, ch)
				settled(tt)
				if err := tt.Click("Next page"); err != nil {
					t.Fatal(err)
				}
				settled(tt)
				saveFrame(t, dir, view.file+"-turned-"+theme+".png", tt.Image())
				tt.Scroll(800, 400, 0, 100000)
				settled(tt)
				saveFrame(t, dir, view.file+"-bottom-"+theme+".png", tt.Image())
			}
		}
	}
}

// A mode without a provider cover remains playable with the host default in either theme.
func TestQishuiMissingCoverModeAction(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	for _, dark := range []bool{false, true} {
		a := qishuiSceneApp(t, fixture)
		ch := posts(a)
		page := fixture.Pages["scene-modes"]
		station := page.Sections[0].Stations[2]
		if station.ImageURL != "" {
			t.Fatal("fixture must include a scene without a cover")
		}
		a.browses = map[string]*browseData{"scene-modes": {page: page}}
		a.route = route{page: pageBrowse, src: "fake", id: "scene-modes"}
		asked := make(chan string, 8)
		fake(a).stationNext = func(id string) ([]music.Track, error) {
			asked <- id
			return sourced(fixture.Tracks...), nil
		}
		tt := ui.NewTester(a.view, 1200, 900)
		tt.SetDark(dark)
		settled(tt)
		if err := tt.Click(station.Name); err != nil {
			t.Fatal(err)
		}
		if id := wait(t, asked, "mode without a cover"); id != station.ID {
			t.Fatal("missing cover changed the requested station")
		}
		until(t, ch, func() bool { return a.pl.Radio() != "" })
		_, id, _ := radioParts(a.pl.Radio())
		if id != station.ID {
			t.Fatal("missing cover changed the active radio")
		}
	}
}

// The exploration row turns its pages in place, and the page it was turned to
// is still there after going to another page and back.
func TestQishui105DiscoveryNavigation(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	a := qishuiSceneApp(t, fixture)
	ch := posts(a)
	page := *fixture.Pages["listening-modes"]
	next := page.Sections[len(page.Sections)-1].NextPage
	if next == "" {
		t.Fatal("the exploration section names no page after it")
	}
	asked := make(chan string, 8)
	fake(a).browse = func(id string) (*music.Browse, error) {
		asked <- id
		return fixture.Pages[id], nil
	}
	a.browses = map[string]*browseData{"listening-modes": {page: &page}}
	a.route = route{page: pageBrowse, src: "fake", id: "listening-modes"}
	tt := ui.NewTester(a.view, 1200, 900)
	settled(tt)
	if page := wait(t, asked, "the batch after the last page"); page != next {
		t.Fatalf("asked for %q, want %q", page, next)
	}
	runPost(t, ch)
	settled(tt)
	if err := tt.Click("Next page"); err != nil {
		t.Fatal(err)
	}
	settled(tt)
	if _, ok := tt.Find("2 / 2"); !ok {
		t.Fatalf("the row shows %q, want 2 / 2", tt.Texts())
	}
	// See All opens the complete catalog, and back returns to the page turned
	// to, without asking the plugin for it again.
	if err := tt.Click("See All"); err != nil {
		t.Fatal(err)
	}
	settled(tt)
	if a.route.id != "scene-modes" {
		t.Fatalf("See All opened %q", a.route.id)
	}
	tt.Key(0, ui.KeyBack)
	settled(tt)
	if a.route.id != "listening-modes" {
		t.Fatalf("back went to %q", a.route.id)
	}
	if _, ok := tt.Find("2 / 2"); !ok {
		t.Fatalf("back shows %q, want 2 / 2", tt.Texts())
	}
	// The host may load the page it went back to anew; the batch the pager
	// already holds is not asked for again.
	for len(asked) > 0 {
		if page := <-asked; page == next {
			t.Fatal("going back asked for the batch it held again")
		}
	}
}

// The native recommendation player starts the recommendation feed and switching a common mode selects that exact feed.
func TestQishui105RecommendationControls(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	a := qishuiSceneApp(t, fixture)
	ch := posts(a)
	a.route = route{page: pageStations, src: "fake"}
	asked := make(chan string, 8)
	fake(a).stationNext = func(id string) ([]music.Track, error) { asked <- id; return sourced(fixture.Tracks...), nil }
	tt := ui.NewTester(a.view, 1200, 900)
	settled(tt)
	if err := tt.Click("Start Listening"); err != nil {
		t.Fatal(err)
	}
	if id := wait(t, asked, "recommendation start"); id != fixture.Stations[0].ID {
		t.Fatal("recommendation started the wrong station")
	}
	until(t, ch, func() bool { return a.pl.Radio() != "" })
	settled(tt)
	if err := tt.Click(fixture.Stations[2].Name); err != nil {
		t.Fatal(err)
	}
	if id := wait(t, asked, "common mode switch"); id != fixture.Stations[2].ID {
		t.Fatal("common mode did not switch its feed")
	}
	until(t, ch, func() bool { _, id, _ := radioParts(a.pl.Radio()); return id == fixture.Stations[2].ID })
}

// The exploration row pages on with the batch the plugin names after it, which
// the same row reaches without leaving the page it is on.
func TestQishui105PagerAsksForTheNextBatch(t *testing.T) {
	fixture := loadQishuiSceneFixtures(t)
	a := qishuiSceneApp(t, fixture)
	ch := posts(a)
	page := *fixture.Pages["listening-modes"]
	next := page.Sections[len(page.Sections)-1].NextPage
	if next == "" {
		t.Fatal("the exploration section names no page after it")
	}
	asked := make(chan string, 8)
	fake(a).browse = func(page string) (*music.Browse, error) {
		asked <- page
		return fixture.Pages[next], nil
	}
	a.browses = map[string]*browseData{"listening-modes": {page: &page}}
	a.route = route{page: pageBrowse, src: "fake", id: "listening-modes"}
	tt := ui.NewTester(a.view, 1200, 900)
	settled(tt)
	// The last page of them shows at once, so the batch after it is asked for
	// without turning to it first.
	if page := wait(t, asked, "the batch after the last page"); page != next {
		t.Fatalf("asked for %q, want %q", page, next)
	}
	runPost(t, ch)
	settled(tt)
	if _, ok := tt.Find("示例电台 46"); !ok {
		t.Fatalf("the batch's cards aren't there: %q", tt.Texts())
	}
	if _, ok := tt.Find("1 / 2"); !ok {
		t.Fatalf("the row shows %q, want 1 / 2", tt.Texts())
	}
	if err := tt.Click("Next page"); err != nil {
		t.Fatal(err)
	}
	settled(tt)
	if _, ok := tt.Find("2 / 2"); !ok {
		t.Fatalf("turning to the batch shows %q, want 2 / 2", tt.Texts())
	}
}
