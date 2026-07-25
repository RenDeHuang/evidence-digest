import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { PageLoading } from './components/PageLoading';
import { TopicSelectionProvider } from './hooks/useTopicSelection';

const Home = lazy(() => import('./pages/Home'));
const Topics = lazy(() => import('./pages/Topics'));
const Feed = lazy(() => import('./pages/Feed'));
const StudyDetail = lazy(() => import('./pages/StudyDetail'));
const Archive = lazy(() => import('./pages/Archive'));
const Sources = lazy(() => import('./pages/Sources'));
const Subscribe = lazy(() => import('./pages/Subscribe'));
const Manage = lazy(() => import('./pages/Manage'));
const About = lazy(() => import('./pages/About'));
const Privacy = lazy(() => import('./pages/Privacy'));
const NotFound = lazy(() => import('./pages/NotFound'));

// import.meta.env.BASE_URL always has a trailing slash (e.g. "/evidence-digest/" or "/");
// react-router's basename wants no trailing slash, so "/" collapses to "".
const basename = import.meta.env.BASE_URL.replace(/\/$/, '');

export default function App() {
  return (
    <BrowserRouter basename={basename}>
      <TopicSelectionProvider>
        <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Home />} />
              <Route path="/topics" element={<Topics />} />
              <Route path="/feed" element={<Feed />} />
              <Route path="/study/:pmid" element={<StudyDetail />} />
              <Route path="/archive" element={<Archive />} />
              <Route path="/sources" element={<Sources />} />
              <Route path="/subscribe" element={<Subscribe />} />
              <Route path="/manage" element={<Manage />} />
              <Route path="/about" element={<About />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </Suspense>
      </TopicSelectionProvider>
    </BrowserRouter>
  );
}
